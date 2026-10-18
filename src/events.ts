import type { EventData, Logger, PluginContext, RuntimeEvent } from "./runtime"
import type { Services } from "./services"
import { MESSAGE_PREFIX } from "./texts"

type EventHandler = (data: EventData) => void

/** High-volume streaming events that are never useful in the debug log. */
const NOISY_EVENT = /delta|streamed|usage|reasoning|text\./

function buildHandlers({ goals, sessions, reminders }: Services): Record<string, EventHandler> {
    const finishTurn = (sessionId: string) => {
        sessions.markIdle(sessionId)
        reminders.scheduleCheck(sessions.rootOf(sessionId))
    }

    /** A failed or interrupted run is not something a reminder can fix. */
    const haltRun = (sessionId: string) => {
        sessions.markIdle(sessionId)
        const goal = goals.get(sessions.rootOf(sessionId))
        if (goal) goal.halted = true
    }

    return {
        "session.step.started": (data) => sessions.markBusy(data.sessionID),
        "session.step.ended": (data) => {
            // "tool-calls" means the agent continues with another step
            if (data.finish !== "tool-calls") finishTurn(data.sessionID)
        },
        "session.idle": (data) => finishTurn(data.sessionID),
        "session.step.failed": (data) => haltRun(data.sessionID),
        "session.execution.failed": (data) => haltRun(data.sessionID),
        "session.execution.interrupted": (data) => haltRun(data.sessionID),
        "session.inbox.enqueued": (data) => {
            const isUserMessage = data.item?.type === "user"
            const isOwnMessage = String(data.item?.payload?.text ?? "").startsWith(MESSAGE_PREFIX)
            if (!isUserMessage || isOwnMessage) return
            const rootId = sessions.rootOf(data.sessionID)
            goals.onUserMessage(rootId)
            reminders.cancelWakeTimer(rootId)
        },
        "session.tool.progress": (data) => {
            if (data.metadata?.shellID) sessions.linkShell(data.metadata.shellID, data.sessionID)
        },
        "shell.created": (data) => sessions.shellStarted(data.info?.id),
        "shell.exited": (data) => {
            const owner = sessions.shellExited(data.id)
            if (owner) reminders.scheduleCheck(sessions.rootOf(owner))
        },
        "session.deleted": (data) => {
            goals.remove(data.sessionID)
            sessions.forget(data.sessionID)
            reminders.cancelWakeTimer(data.sessionID)
        },
    }
}

/** Consumes the runtime event stream in the background and feeds the handlers. */
export function watchEvents(context: PluginContext, services: Services, log: Logger, debug: boolean): void {
    const handlers = buildHandlers(services)
    const projectDirectory = context.location.project.directory

    const handle = (event: RuntimeEvent) => {
        const isOtherProject = event.location && !event.location.directory.startsWith(projectDirectory)
        if (isOtherProject) return
        if (debug && !NOISY_EVENT.test(event.type)) log("event", event.type, JSON.stringify(event.data).slice(0, 200))

        if (event.data?.sessionID) services.sessions.track(event.data.sessionID)
        try {
            handlers[event.type]?.(event.data ?? {})
        } catch (error) {
            log("event handler failed", event.type, String(error))
        }
    }

    void (async () => {
        for await (const event of context.event.subscribe()) handle(event)
    })()
}
