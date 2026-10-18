import { appendFileSync } from "node:fs"
import { watchEvents } from "./events"
import { GoalBook } from "./goals"
import { registerGoalCommand, registerGoalTool, registerHooks } from "./registrations"
import { Reminders } from "./reminders"
import type { Logger, PluginContext } from "./runtime"
import { SessionTree } from "./sessions"

const DEFAULT_MAX_UNANSWERED_REMINDERS = 5
const DEFAULT_MAX_WAIT_MINUTES = 30

/** Writes debug lines to the file named by GOAL_DEBUG; does nothing when unset. */
function createLogger(debugFile: string | undefined): Logger {
    if (!debugFile) return () => {}
    return (...values) => appendFileSync(debugFile, JSON.stringify(values) + "\n")
}

export default {
    id: "goal",

    async setup(context: PluginContext) {
        const debugFile = process.env.GOAL_DEBUG
        const log = createLogger(debugFile)
        const maxWaitMinutes = Number(context.options.maxWaitMinutes ?? DEFAULT_MAX_WAIT_MINUTES)
        const maxUnansweredReminders = Number(context.options.maxStrikes ?? DEFAULT_MAX_UNANSWERED_REMINDERS)

        const goals = new GoalBook(maxWaitMinutes)
        const sessions = new SessionTree((sessionID) => context.session.get({ sessionID }), log)
        const reminders = new Reminders(context, goals, sessions, { maxUnansweredReminders }, log)
        const services = { goals, sessions, reminders }

        await registerGoalCommand(context, services)
        await registerGoalTool(context, services)
        await registerHooks(context, services)
        watchEvents(context, services, log, Boolean(debugFile))
    },
}
