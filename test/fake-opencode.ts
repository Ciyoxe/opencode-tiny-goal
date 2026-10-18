import plugin from "../src/index"
import type { CommandInvocation, PluginContext, RuntimeEvent, SystemEntry } from "../src/runtime"

export const PROJECT_DIRECTORY = "/project"

type RegisteredCommand = { execute(invocation: CommandInvocation): Promise<void> }
type RegisteredTool = { execute(input: Record<string, unknown>, call: { sessionID: string }): Promise<{ content: string }> }

/** An async iterable the test can push events into. */
class EventFeed implements AsyncIterable<RuntimeEvent> {
    private readonly queued: RuntimeEvent[] = []
    private waiting: ((event: RuntimeEvent) => void) | undefined

    push(event: RuntimeEvent): void {
        if (this.waiting) {
            this.waiting(event)
            this.waiting = undefined
            return
        }
        this.queued.push(event)
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeEvent> {
        while (true) {
            const next = this.queued.shift()
            yield next ?? (await new Promise<RuntimeEvent>((resolve) => (this.waiting = resolve)))
        }
    }
}

/** Starts the real plugin against a fake opencode and exposes what it did. */
export async function startPlugin(options: Record<string, unknown> = {}) {
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
        location: { directory: PROJECT_DIRECTORY, project: { directory: PROJECT_DIRECTORY } },
        event: { subscribe: () => feed },
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

    await plugin.setup(context)

    return {
        sentPrompts,
        sentNotes,

        /** Makes `child` a subagent of `parent`. */
        setParent(child: string, parent: string) {
            parentOf[child] = parent
        },

        emit(type: string, data: Record<string, unknown> = {}, directory = PROJECT_DIRECTORY) {
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
