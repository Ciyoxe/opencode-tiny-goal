import type { GoalBook } from "./goals"
import type { Reminders } from "./reminders"
import type { SessionTree } from "./sessions"

/** The pieces every part of the plugin works with. */
export type Services = {
    goals: GoalBook
    sessions: SessionTree
    reminders: Reminders
}
