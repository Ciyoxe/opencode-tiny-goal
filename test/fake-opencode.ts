import plugin from "../src/index"
import type { CommandInvocation, PluginContext, RuntimeEvent, SystemEntry } from "../src/runtime"

export const PROJECT_DIRECTORY = "/project"

type RegisteredCommand = { execute(invocation: CommandInvocation): Promise<void> }
type RegisteredTool = { execute(input: Record<string, unknown>, call: { sessionID: string }): Promise<{ content: string }> }

/** An async iterable the test can push events into. */
class EventFeed implements AsyncIterable<RuntimeEvent> {
    private readonly queued: RuntimeEvent[] = []
    private waiting: ((event: RuntimeEvent | undefined) => void) | undefined
    private closed = false

    push(event: RuntimeEvent): void {
        if (this.waiting) {
            this.waiting(event)
            this.waiting = undefined
            return
        }
        this.queued.push(event)
    }

    /** Like the real stream: an abort ends the subscription. */
    subscribe(signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
        if (signal) signal.addEventListener("abort", () => this.close(), { once: true })
        return this
    }

    close(): void {
        this.closed = true
        this.waiting?.(undefined)
        this.waiting = undefined
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeEvent> {
        while (!this.closed) {
            const next = this.queued.shift()
            const event = next ?? (await new Promise<RuntimeEvent | undefined>((resolve) => (this.waiting = resolve)))
            if (event === undefined || this.closed) return
            yield event
        }
    }
}

/** Storage that outlives a plugin instance, like opencode's on-disk storage outlives a restart. */
export class FakeStorage {
    readonly values = new Map<string, unknown>()
    failReads = false
    failWrites = false

    readonly api: PluginContext["storage"] = {
        get: async (key) => {
            if (this.failReads) throw new Error("storage unavailable")
            return structuredClone(this.values.get(JSON.stringify(key)))
        },
        set: async (key, value) => {
            if (this.failWrites) throw new Error("storage unavailable")
            this.values.set(JSON.stringify(key), structuredClone(value))
        },
    }

    /** The saved goals of a project, as stored. */
    goalsOf(projectDirectory: string): unknown {
        return this.values.get(JSON.stringify(["opencode-tiny-goal", "goals", projectDirectory]))
    }
}

type Environment = { storage?: FakeStorage; directory?: string }

/** Starts the real plugin against a fake opencode and exposes what it did. */
export async function startPlugin(options: Record<string, unknown> = {}, environment: Environment = {}) {
    const projectDirectory = environment.directory ?? PROJECT_DIRECTORY
    const storage = environment.storage ?? new FakeStorage()
    const feed = new EventFeed()
    const sentPrompts: { sessionID: string; text: string; delivery?: string }[] = []
    const sentNotes: { sessionID: string; text: string }[] = []
    const parentOf: Record<string, string> = {}
    let command: RegisteredCommand | undefined
    let tool: RegisteredTool | undefined
    let onToolCall: ((call: { tool: string; sessionID: string }) => void) | undefined
    let onContext: ((turn: { sessionID: string; system: SystemEntry[] }) => void) | undefined

    const context: PluginContext = {
        options,
        location: { directory: projectDirectory, project: { directory: projectDirectory } },
        event: { subscribe: (options) => feed.subscribe(options?.signal) },
        storage: storage.api,
        session: {
            get: async ({ sessionID }) => ({ data: { id: sessionID, parentID: parentOf[sessionID] } }),
            prompt: async (input) => void sentPrompts.push(input),
            synthetic: async (input) => void sentNotes.push(input),
            hook: async (_name, callback) => void (onContext = callback),
        },
        tool: {
            transform: async (callback) => callback({ add: (added) => void (tool = added as RegisteredTool) }),
            hook: async (_name, callback) => void (onToolCall = callback),
        },
        command: {
            transform: async (callback) => callback({ add: (added) => void (command = added as RegisteredCommand) }),
        },
    }

    const cleanup = await plugin.setup(context)
    const stop = typeof cleanup === "function" ? cleanup : () => {}

    return {
        storage,
        sentPrompts,
        sentNotes,

        /** Unloads the plugin instance, as a reload does. */
        stop,

        /** Makes `child` a subagent of `parent`. */
        setParent(child: string, parent: string) {
            parentOf[child] = parent
        },

        emit(type: string, data: Record<string, unknown> = {}, directory = projectDirectory) {
            feed.push({ type, data, location: { directory } })
        },

        runCommand(sessionID: string, text: string, delivery?: "steer" | "queue") {
            return command!.execute({ sessionID, prompt: { text }, delivery })
        },

        async callGoalTool(sessionID: string, input: Record<string, unknown>) {
            return (await tool!.execute(input, { sessionID })).content
        },

        /** The agent calls some tool; the goal tool itself does not count. */
        reportToolCall(sessionID: string, toolName = "read") {
            onToolCall!({ tool: toolName, sessionID })
        },

        systemEntriesFor(sessionID: string): string[] {
            const turn = { sessionID, system: [] as SystemEntry[] }
            onContext!(turn)
            return turn.system.map((entry) => entry.text)
        },
    }
}

export type FakePlugin = Awaited<ReturnType<typeof startPlugin>>
