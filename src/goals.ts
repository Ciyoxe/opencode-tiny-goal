export type GoalAction = "set" | "done" | "clear" | "pause" | "resume" | "wait" | "status"

export type GoalActionInput = { text?: string; minutes?: number }

export type Goal = {
    text: string
    status: "active" | "paused"
    /** No reminders before this timestamp (ms); set by the agent's wait action. */
    waitUntil?: number
    /** The last run failed or was interrupted, so reminders stay off until the user writes again. */
    halted: boolean
    /** A reminder was sent and has not been evaluated yet. */
    reminderPending: boolean
    toolCallsSinceReminder: number
    /** Consecutive reminders after which the agent still made no tool call. */
    unansweredReminders: number
}

/** The part of a goal that survives a restart. */
export type SavedGoal = Pick<Goal, "text" | "status">

export type GoalChangeListener = (sessionId: string, saved: SavedGoal | undefined) => void

const MS_PER_MINUTE = 60_000

function createGoal(text: string): Goal {
    return {
        text,
        status: "active",
        halted: false,
        reminderPending: false,
        toolCallsSinceReminder: 0,
        unansweredReminders: 0,
    }
}

/** In-memory goals, one per root session. All state changes go through here. */
export class GoalBook {
    private readonly goals = new Map<string, Goal>()

    constructor(
        private readonly maxWaitMinutes: number,
        private readonly onChange: GoalChangeListener = () => {},
    ) {}

    get(sessionId: string): Goal | undefined {
        return this.goals.get(sessionId)
    }

    has(sessionId: string): boolean {
        return this.goals.has(sessionId)
    }

    remove(sessionId: string): void {
        if (this.goals.delete(sessionId)) this.onChange(sessionId, undefined)
    }

    /** Sets a new goal, replacing any existing one. */
    start(sessionId: string, text: string): void {
        this.goals.set(sessionId, createGoal(text))
        this.notifyChanged(sessionId)
    }

    /** Puts back a goal saved before a restart, without announcing it as a change. */
    restore(sessionId: string, saved: SavedGoal): void {
        this.goals.set(sessionId, { ...createGoal(saved.text), status: saved.status })
    }

    /** Applies an action and returns a short human-readable result. */
    apply(sessionId: string, action: GoalAction, input: GoalActionInput = {}): string {
        const goal = this.goals.get(sessionId)
        if (action === "set") return this.setText(sessionId, goal, input.text)
        if (action === "status") return goal ? `Goal (${goal.status}): ${goal.text}` : "No goal."
        if (!goal) return "No goal."

        switch (action) {
            case "done":
            case "clear":
                this.remove(sessionId)
                return "Goal finished."
            case "pause":
                goal.status = "paused"
                this.notifyChanged(sessionId)
                return "Goal paused."
            case "resume":
                this.resume(goal)
                this.notifyChanged(sessionId)
                return "Goal resumed."
            case "wait":
                return this.wait(goal, input.minutes)
        }
    }

    /** A real user message clears everything that suppresses or counts reminders. */
    onUserMessage(sessionId: string): void {
        const goal = this.goals.get(sessionId)
        if (!goal) return
        goal.halted = false
        goal.waitUntil = undefined
        goal.reminderPending = false
        goal.unansweredReminders = 0
    }

    /** The agent called a tool (other than the goal tool itself). */
    onToolCall(sessionId: string): void {
        const goal = this.goals.get(sessionId)
        if (goal) goal.toolCallsSinceReminder++
    }

    private setText(sessionId: string, goal: Goal | undefined, text: string | undefined): string {
        const trimmed = text?.trim()
        if (!trimmed) return "Error: text is required."
        if (goal) {
            goal.text = trimmed
            this.notifyChanged(sessionId)
            return "Goal updated."
        }
        this.start(sessionId, trimmed)
        return "Goal set."
    }

    private notifyChanged(sessionId: string): void {
        const goal = this.goals.get(sessionId)
        if (goal) this.onChange(sessionId, { text: goal.text, status: goal.status })
    }

    private resume(goal: Goal): void {
        goal.status = "active"
        goal.waitUntil = undefined
        goal.reminderPending = false
        goal.unansweredReminders = 0
    }

    private wait(goal: Goal, requestedMinutes: number | undefined): string {
        const minutes = Math.min(requestedMinutes ?? this.maxWaitMinutes, this.maxWaitMinutes)
        goal.waitUntil = Date.now() + minutes * MS_PER_MINUTE
        return `Not pushing for ${minutes} min.`
    }
}
