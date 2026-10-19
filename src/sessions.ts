import type { Logger } from "./runtime"

type SessionLookup = (sessionId: string) => Promise<any>

export type SessionTreeOptions = {
    /** How long a just-started shell can count as work, and how often an ignored push may repeat. */
    maxShellMinutes: number
    /** How long a session may keep looking busy before reminders resume. */
    maxBusyMinutes: number
}

/** A shell command a session started, and what the agent looked like when it did. */
type RunningShell = {
    sessionId: string
    startedAt: number
    /** The root's tool-call count when the shell started; a later call means the agent moved on. */
    toolCallsAtStart: number
}

/** Tracks which sessions are working, how they nest (subagents), and which shells they may be waiting for. */
export class SessionTree {
    private readonly parentOf = new Map<string, string | null>()
    /** Busy sessions with the moment they last started a step. */
    private readonly busySessions = new Map<string, number>()
    private readonly toolCalls = new Map<string, number>()
    private readonly shells = new Map<string, RunningShell>()

    constructor(
        private readonly lookupSession: SessionLookup,
        private readonly log: Logger,
        private readonly options: SessionTreeOptions,
    ) {}

    /** Follows parent links up to the session the user is talking to. */
    rootOf(sessionId: string): string {
        let current = sessionId
        for (let parent = this.parentOf.get(current); parent; parent = this.parentOf.get(current)) {
            current = parent
        }
        return current
    }

    /** Learns a session's parent in the background; until then it counts as a root. */
    track(sessionId: string): void {
        if (this.parentOf.has(sessionId)) return
        this.parentOf.set(sessionId, null)
        this.lookupSession(sessionId)
            .then((response) => this.parentOf.set(sessionId, (response?.data ?? response)?.parentID ?? null))
            .catch((error) => this.log("session lookup failed", String(error)))
    }

    forget(sessionId: string): void {
        this.parentOf.delete(sessionId)
        this.busySessions.delete(sessionId)
    }

    markBusy(sessionId: string): void {
        this.busySessions.set(sessionId, Date.now())
    }

    markIdle(sessionId: string): void {
        this.busySessions.delete(sessionId)
    }

    /** An agent tool call; a command started before it is no longer something the agent waits for. */
    noteToolCall(sessionId: string): void {
        const rootId = this.rootOf(sessionId)
        this.toolCalls.set(rootId, (this.toolCalls.get(rootId) ?? 0) + 1)
    }

    shellStarted(shellId: string, sessionId: string): void {
        const rootId = this.rootOf(sessionId)
        this.shells.set(shellId, {
            sessionId,
            startedAt: Date.now(),
            toolCallsAtStart: this.toolCalls.get(rootId) ?? 0,
        })
    }

    shellEnded(shellId: string): void {
        this.shells.delete(shellId)
    }

    /** True while any shell of the root runs, however long ago it started. */
    hasRunningShell(rootId: string): boolean {
        return this.shellsFor(rootId).length > 0
    }

    /**
     * True while the root or a subagent may be working: busy for less than maxBusyMinutes since its
     * last step began, or a shell it started and did not move on from, for at most maxShellMinutes.
     * Every reason expires, so nothing can keep a goal silent forever.
     */
    hasActiveWork(rootId: string): boolean {
        const now = Date.now()
        const busy = [...this.busySessions].some(
            ([sessionId, since]) => this.rootOf(sessionId) === rootId && now - since < this.options.maxBusyMinutes * 60_000,
        )
        return busy || this.awaitedShells(rootId).length > 0
    }

    /**
     * When the last shell the agent may be waiting for stops counting as work, or undefined if there is none.
     * Nothing else happens at that moment, so whoever skipped a reminder because of it must look again then.
     */
    shellGraceEndsAt(rootId: string): number | undefined {
        const ends = this.awaitedShells(rootId).map((shell) => shell.startedAt + this.shellWindowMs())
        return ends.length > 0 ? Math.max(...ends) : undefined
    }

    /** Running shells of the root that were started after the agent's last tool call and are still in their window. */
    private awaitedShells(rootId: string): RunningShell[] {
        const current = this.toolCalls.get(rootId) ?? 0
        const now = Date.now()
        return this.shellsFor(rootId).filter(
            (shell) => shell.toolCallsAtStart === current && now - shell.startedAt < this.shellWindowMs(),
        )
    }

    private shellWindowMs(): number {
        return this.options.maxShellMinutes * 60_000
    }

    private shellsFor(rootId: string): RunningShell[] {
        return [...this.shells.values()].filter((shell) => this.rootOf(shell.sessionId) === rootId)
    }
}
