import type { Logger } from "./runtime"

type SessionLookup = (sessionId: string) => Promise<any>

const LOOKUP_RETRY_MS = 5_000

export type SessionTreeOptions = {
    /** How long a session may keep looking busy before reminders resume. */
    maxBusyMinutes: number
}

/** A shell command a session started. */
type RunningShell = {
    sessionId: string
    startedAt: number
}

/** Tracks which sessions are working, how they nest (subagents), and which shell commands they run. */
export class SessionTree {
    private readonly parentOf = new Map<string, string | null>()
    /** When a session's lookup last failed; it is tried again only after LOOKUP_RETRY_MS. */
    private readonly lookupFailedAt = new Map<string, number>()
    /** Busy sessions with the moment they last started a step. */
    private readonly busySessions = new Map<string, number>()
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

    /**
     * Learns a session's parent. `session.created` carries it, so pass it in; otherwise look it up in
     * the background. Until the answer arrives the session counts as a root.
     */
    track(sessionId: string, parentId?: string | null): void {
        if (parentId !== undefined) {
            this.parentOf.set(sessionId, parentId)
            return
        }
        if (this.parentOf.has(sessionId)) return
        // Streaming events arrive many times a second, so a failing lookup must not repeat on each one.
        const failedAt = this.lookupFailedAt.get(sessionId)
        if (failedAt !== undefined && Date.now() - failedAt < LOOKUP_RETRY_MS) return
        this.parentOf.set(sessionId, null)
        this.lookupSession(sessionId)
            .then((response) => {
                this.lookupFailedAt.delete(sessionId)
                this.parentOf.set(sessionId, (response?.data ?? response)?.parentID ?? null)
            })
            .catch((error) => {
                // Forget the placeholder so a later event can look the session up again.
                this.parentOf.delete(sessionId)
                this.lookupFailedAt.set(sessionId, Date.now())
                this.log("session lookup failed", String(error))
            })
    }

    forget(sessionId: string): void {
        this.parentOf.delete(sessionId)
        this.lookupFailedAt.delete(sessionId)
        this.busySessions.delete(sessionId)
    }

    /** Drops all state, so a reloaded plugin instance starts clean. */
    stop(): void {
        this.parentOf.clear()
        this.lookupFailedAt.clear()
        this.busySessions.clear()
        this.shells.clear()
    }

    markBusy(sessionId: string): void {
        this.busySessions.set(sessionId, Date.now())
    }

    /** True between a session's first step and the end of its turn. */
    isInTurn(sessionId: string): boolean {
        return this.busySessions.has(sessionId)
    }

    markIdle(sessionId: string): void {
        this.busySessions.delete(sessionId)
    }

    shellStarted(shellId: string, sessionId: string): void {
        this.shells.set(shellId, { sessionId, startedAt: Date.now() })
    }

    shellEnded(shellId: string): void {
        this.shells.delete(shellId)
    }

    /** When the newest shell still running in the root or its subagents started, or undefined if none runs. */
    lastShellStartedAt(rootId: string): number | undefined {
        const starts = this.shellsFor(rootId).map((shell) => shell.startedAt)
        return starts.length > 0 ? Math.max(...starts) : undefined
    }

    /**
     * True while the root or a subagent is working, for at most maxBusyMinutes since its last step began,
     * so a session that never reports its end cannot keep a goal silent forever.
     */
    isBusy(rootId: string): boolean {
        const now = Date.now()
        return [...this.busySessions].some(
            ([sessionId, since]) => this.rootOf(sessionId) === rootId && now - since < this.options.maxBusyMinutes * 60_000,
        )
    }

    private shellsFor(rootId: string): RunningShell[] {
        return [...this.shells.values()].filter((shell) => this.rootOf(shell.sessionId) === rootId)
    }
}
