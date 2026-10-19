import { appendFileSync } from "node:fs"
import { watchEvents } from "./events"
import { GoalBook } from "./goals"
import { GoalPersistence } from "./persistence"
import { registerGoalCommand, registerGoalTool, registerHooks } from "./registrations"
import { Reminders } from "./reminders"
import type { Logger, PluginContext } from "./runtime"
import { SessionTree } from "./sessions"

const DEFAULT_MAX_UNANSWERED_REMINDERS = 5
const DEFAULT_MAX_WAIT_MINUTES = 30
const DEFAULT_MAX_SHELL_MINUTES = 5

/** Config options may be missing, negative or nonsense; fall back to the default. */
function positiveNumber(value: unknown, fallback: number): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Writes debug lines to the file named by GOAL_DEBUG; does nothing when unset. */
function createLogger(debugFile: string | undefined): Logger {
    if (!debugFile) return () => {}
    return (...values) => appendFileSync(debugFile, JSON.stringify(values) + "\n")
}

export default {
    id: "tiny-goal",

    async setup(context: PluginContext) {
        const debugFile = process.env.GOAL_DEBUG
        const log = createLogger(debugFile)
        const maxWaitMinutes = positiveNumber(context.options.maxWaitMinutes, DEFAULT_MAX_WAIT_MINUTES)
        const maxUnansweredReminders = positiveNumber(
            context.options.maxUnansweredReminders,
            DEFAULT_MAX_UNANSWERED_REMINDERS,
        )
        const maxShellMinutes = positiveNumber(context.options.maxShellMinutes, DEFAULT_MAX_SHELL_MINUTES)

        const persistence = new GoalPersistence(context.storage, context.location.project.directory, log)
        const goals = new GoalBook(maxWaitMinutes, (sessionId, goal) => persistence.update(sessionId, goal))
        await persistence.restoreInto(goals)
        const sessions = new SessionTree((sessionID) => context.session.get({ sessionID }), log, {
            maxShellMinutes,
            maxBusyMinutes: maxWaitMinutes,
        })
        const reminders = new Reminders(context, goals, sessions, { maxUnansweredReminders, maxShellMinutes }, log)
        const services = { goals, sessions, reminders }

        await registerGoalCommand(context, services)
        await registerGoalTool(context, services)
        await registerHooks(context, services)
        watchEvents(context, services, log, Boolean(debugFile))
    },
}
