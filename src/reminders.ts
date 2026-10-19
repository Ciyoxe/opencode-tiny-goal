import type { Goal, GoalBook } from "./goals"
import type { Logger, PluginContext } from "./runtime"
import type { SessionTree } from "./sessions"
import * as texts from "./texts"

/** A finished turn may be followed immediately by queued work, so wait a moment before judging. */
const SETTLE_DELAY_MS = 500
const WAKE_MARGIN_MS = 50
const MS_PER_MINUTE = 60_000

type ReminderLimits = { maxUnansweredReminders: number; maxShellMinutes: number }

/** Decides when the agent needs a reminder about its goal, and sends it. */
export class Reminders {
    private readonly settleTimers = new Map<string, ReturnType<typeof setTimeout>>()
    private readonly wakeTimers = new Map<string, ReturnType<typeof setTimeout>>()
    /** Looks again when a time-limited reason to stay quiet runs out, since no event marks that moment. */
    private readonly recheckTimers = new Map<string, ReturnType<typeof setTimeout>>()
    /** When each root was last pushed; while a command runs, pushes are spaced a shell window apart. */
    private readonly lastPushedAt = new Map<string, number>()

    constructor(
        private readonly context: PluginContext,
        private readonly goals: GoalBook,
        private readonly sessions: SessionTree,
        private readonly limits: ReminderLimits,
        private readonly log: Logger,
    ) {}

    /** Checks whether to send a reminder once things have settled. */
    scheduleCheck(rootId: string): void {
        clearTimeout(this.settleTimers.get(rootId))
        const timer = setTimeout(() => {
            this.settleTimers.delete(rootId)
            void this.check(rootId)
        }, SETTLE_DELAY_MS)
        this.settleTimers.set(rootId, timer)
    }

    /** Aligns the wake-up timer with the goal's current wait period (or removes it). */
    syncWakeTimer(rootId: string): void {
        this.cancelWakeTimer(rootId)
        const waitUntil = this.goals.get(rootId)?.waitUntil
        if (waitUntil === undefined) return
        const delay = Math.max(0, waitUntil - Date.now()) + WAKE_MARGIN_MS
        this.wakeTimers.set(rootId, setTimeout(() => this.scheduleCheck(rootId), delay))
    }

    cancelWakeTimer(rootId: string): void {
        clearTimeout(this.wakeTimers.get(rootId))
        this.wakeTimers.delete(rootId)
    }

    /** Drops every timer and record of a session that no longer exists. */
    forget(rootId: string): void {
        this.cancelWakeTimer(rootId)
        clearTimeout(this.settleTimers.get(rootId))
        this.settleTimers.delete(rootId)
        clearTimeout(this.recheckTimers.get(rootId))
        this.recheckTimers.delete(rootId)
        this.lastPushedAt.delete(rootId)
    }

    /** Cancels every pending timer, so a reloaded plugin instance cannot keep pushing. */
    stop(): void {
        for (const timer of this.settleTimers.values()) clearTimeout(timer)
        for (const timer of this.wakeTimers.values()) clearTimeout(timer)
        for (const timer of this.recheckTimers.values()) clearTimeout(timer)
        this.settleTimers.clear()
        this.wakeTimers.clear()
        this.recheckTimers.clear()
        this.lastPushedAt.clear()
    }

    /** Adds a short note to the transcript without starting a model turn. */
    async note(sessionId: string, text: string): Promise<void> {
        await this.context.session
            .synthetic({ sessionID: sessionId, text, description: text, resume: false })
            .catch((error) => this.log("note failed", String(error)))
    }

    private async check(rootId: string): Promise<void> {
        const goal = this.goals.get(rootId)
        if (!goal || goal.status !== "active" || goal.haltedBy) return
        if (this.sessions.isBusy(rootId)) return
        if (goal.waitUntil !== undefined && goal.waitUntil > Date.now()) return
        const shellQuietUntil = this.shellQuietUntil(rootId)
        if (shellQuietUntil !== undefined && Date.now() < shellQuietUntil) {
            this.recheckAt(rootId, shellQuietUntil)
            return
        }

        const waitJustEnded = goal.waitUntil !== undefined
        goal.waitUntil = undefined

        this.countUnansweredReminder(goal)
        if (goal.unansweredReminders >= this.limits.maxUnansweredReminders) {
            const pushCount = goal.unansweredReminders
            this.goals.apply(rootId, "pause")
            await this.note(rootId, texts.pausedForNoProgress(pushCount))
            return
        }

        goal.reminderPending = true
        goal.toolCallsSinceReminder = 0
        await this.sendReminder(rootId, waitJustEnded ? texts.waitOverReminder(goal.text) : texts.reminder(goal.text))
    }

    /**
     * opencode wakes the agent when its command ends, so pushing on every turn while one runs only makes
     * the agent poll it. A long command, or a dev server that never ends, still gets a push once per window.
     */
    private shellQuietUntil(rootId: string): number | undefined {
        const shellStartedAt = this.sessions.lastShellStartedAt(rootId)
        if (shellStartedAt === undefined) return undefined
        const lastPush = this.lastPushedAt.get(rootId) ?? 0
        return Math.max(shellStartedAt, lastPush) + this.limits.maxShellMinutes * MS_PER_MINUTE
    }

    private recheckAt(rootId: string, time: number): void {
        clearTimeout(this.recheckTimers.get(rootId))
        const delay = Math.max(0, time - Date.now()) + WAKE_MARGIN_MS
        const timer = setTimeout(() => {
            this.recheckTimers.delete(rootId)
            this.scheduleCheck(rootId)
        }, delay)
        this.recheckTimers.set(rootId, timer)
    }

    /** A reminder counts as unanswered when the turn it started ended without any tool call. */
    private countUnansweredReminder(goal: Goal): void {
        const lastReminderWasIgnored = goal.reminderPending && goal.toolCallsSinceReminder === 0
        goal.unansweredReminders = lastReminderWasIgnored ? goal.unansweredReminders + 1 : 0
    }

    private async sendReminder(rootId: string, text: string): Promise<void> {
        this.lastPushedAt.set(rootId, Date.now())
        await this.context.session
            .prompt({ sessionID: rootId, text, delivery: "queue" })
            .catch((error) => this.log("reminder failed", String(error)))
    }
}
