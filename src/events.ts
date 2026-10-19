import type { HaltReason } from "./goals"
import type { EventData, Logger, PluginContext, RuntimeEvent } from "./runtime"
import type { Services } from "./services"
import { MESSAGE_PREFIX } from "./texts"

type EventHandler = (data: EventData) => void

/** High-volume streaming events that are never useful in the debug log. */
const NOISY_EVENT = /delta|streamed|usage|reasoning|text\./

function buildHandlers({ goals, sessions, reminders }: Services): Record<string, EventHandler> {
    const finishTurn = (sessionId: string) => {
        sessions.markIdle(sessionId)
        const rootId = sessions.rootOf(sessionId)
        // A finishing subagent wakes its parent with the result, so only the parent's own turn end decides a reminder.
        if (rootId === sessionId) reminders.scheduleCheck(rootId)
    }

    /** A failed or interrupted run is not something a reminder can fix. A user stop outranks a failure. */
    const haltRun = (sessionId: string, reason: HaltReason) => {
        sessions.markIdle(sessionId)
        const goal = goals.get(sessions.rootOf(sessionId))
        if (goal && goal.haltedBy !== "user") goal.haltedBy = reason
    }

    /**
     * A run that succeeded means the session works again, so an earlier failure stops muting reminders.
     * A user stop stays: background jobs finishing after Esc wake the agent and would otherwise undo it.
     */
    const clearFailure = (sessionId: string) => {
        const goal = goals.get(sessions.rootOf(sessionId))
        if (goal?.haltedBy === "failure") goal.haltedBy = undefined
    }

    return {
        "session.step.started": (data) => sessions.markBusy(data.sessionID),
        "session.step.ended": (data) => {
            // "tool-calls" means the agent continues with another step
            if (data.finish !== "tool-calls") finishTurn(data.sessionID)
        },
        "session.idle": (data) => finishTurn(data.sessionID),
        "session.step.failed": (data) => haltRun(data.sessionID, "failure"),
        "session.execution.failed": (data) => haltRun(data.sessionID, "failure"),
        // Only Esc is the user's stop; "superseded", "inactivity" and "shutdown" are not.
        "session.execution.interrupted": (data) =>
            haltRun(data.sessionID, data.reason === "user" ? "user" : "failure"),
        "session.execution.succeeded": (data) => clearFailure(data.sessionID),
        "session.inbox.enqueued": (data) => {
            const isUserMessage = data.item?.type === "user"
            const isOwnMessage = String(data.item?.payload?.text ?? "").startsWith(MESSAGE_PREFIX)
            if (!isUserMessage || isOwnMessage) return
            const rootId = sessions.rootOf(data.sessionID)
            goals.onUserMessage(rootId)
            reminders.cancelWakeTimer(rootId)
        },
        // Every command, the agent's bash tool and the user's `!` alike, runs in a shell tagged with its session.
        "shell.created": (data) => {
            const sessionId = data.info?.metadata?.sessionID
            if (data.info?.id && sessionId) sessions.shellStarted(data.info.id, sessionId)
        },
        "shell.exited": (data) => {
            if (data.id) sessions.shellEnded(data.id)
        },
        "shell.deleted": (data) => {
            if (data.id) sessions.shellEnded(data.id)
        },
        "session.deleted": (data) => {
            goals.remove(data.sessionID)
            sessions.forget(data.sessionID)
            reminders.forget(data.sessionID)
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
