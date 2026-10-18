import type { Logger } from "./runtime"

type SessionLookup = (sessionId: string) => Promise<any>

/** Tracks which sessions are working, how they nest (subagents), and which shell commands run. */
export class SessionTree {
    private readonly parentOf = new Map<string, string | null>()
    private readonly busySessions = new Set<string>()
    private readonly shellSession = new Map<string, string>()
    private readonly runningShells = new Set<string>()

    constructor(
        private readonly lookupSession: SessionLookup,
        private readonly log: Logger,
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
        this.busySessions.add(sessionId)
    }

    markIdle(sessionId: string): void {
        this.busySessions.delete(sessionId)
    }

    /** A tool call reported which shell process it started. */
    linkShell(shellId: string, sessionId: string): void {
        this.shellSession.set(shellId, sessionId)
    }

    shellStarted(shellId: string): void {
        if (this.shellSession.has(shellId)) this.runningShells.add(shellId)
    }

    /** Returns the session that owned the shell, if known. */
    shellExited(shellId: string): string | undefined {
        const owner = this.shellSession.get(shellId)
        this.shellSession.delete(shellId)
        this.runningShells.delete(shellId)
        return owner
    }

    /** True while the root session, a subagent of it, or one of their shell commands is running. */
    hasActiveWork(rootId: string): boolean {
        const busyOwners = [...this.busySessions, ...this.runningShellOwners()]
        return busyOwners.some((sessionId) => this.rootOf(sessionId) === rootId)
    }

    private runningShellOwners(): string[] {
        return [...this.runningShells].flatMap((shellId) => this.shellSession.get(shellId) ?? [])
    }
}
