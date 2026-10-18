/**
 * The published v2 plugin types lag behind the runtime, so this is the subset of the
 * runtime context the plugin relies on (verified by probing opencode 2.0.31).
 */

export type EventData = Record<string, any>

export type RuntimeEvent = {
    type: string
    data: EventData
    location?: { directory: string }
}

export type Delivery = "steer" | "queue"

export type SystemEntry = { type: "text"; text: string }

export type CommandInvocation = {
    sessionID: string
    prompt: { text: string }
    delivery?: Delivery
}

export type ToolCallContext = { sessionID: string }

export type PluginContext = {
    options: Record<string, any>
    location: { directory: string; project: { directory: string } }
    event: { subscribe(): AsyncIterable<RuntimeEvent> }
    session: {
        get(input: { sessionID: string }): Promise<any>
        prompt(input: { sessionID: string; text: string; delivery?: Delivery }): Promise<unknown>
        synthetic(input: { sessionID: string; text: string; description?: string; resume?: boolean }): Promise<unknown>
        hook(name: "context", callback: (input: { sessionID: string; system: SystemEntry[] }) => void): Promise<unknown>
    }
    tool: {
        transform(callback: (draft: { add(tool: unknown): void }) => void): Promise<unknown>
        hook(name: "execute.before", callback: (input: { tool: string; sessionID: string }) => void): Promise<unknown>
    }
    command: {
        transform(callback: (draft: { add(command: unknown): void }) => void): Promise<unknown>
    }
}

export type Logger = (...values: unknown[]) => void
