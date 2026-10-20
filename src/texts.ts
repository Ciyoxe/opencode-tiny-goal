/** Prefix of every message the plugin sends, so its own messages can be told apart from the user's. */
export const MESSAGE_PREFIX = "[goal]"

/**
 * Shown on every step, so it states facts only: pressure to keep working on every step makes the agent
 * poll and sleep instead of waiting, and reminders already push when it really stops.
 * It never changes with the goal's state, since a changing system prompt would break the prompt cache.
 */
export function systemLine(goalText: string): string {
    return [`Active goal (set by the user): ${goalText}`, "Call goal(done) once it is fully achieved."].join("\n")
}

export function reminder(goalText: string): string {
    return `${MESSAGE_PREFIX} Not done yet: ${goalText}. Continue, or call goal(done) if it's achieved.`
}

export function waitOverReminder(goalText: string): string {
    return `${MESSAGE_PREFIX} Wait is over, goal is still active: ${goalText}. Check on what you were waiting for and continue.`
}

export function pausedForNoProgress(pushCount: number): string {
    return `${MESSAGE_PREFIX} Paused: ${pushCount} pushes in a row without progress. The user can /goal resume.`
}

export const TOOL_DESCRIPTION = [
    "Manage the user's active goal.",
    "- done: the goal is achieved.",
    '- set: replace the goal text with a clearer one (requires "text").',
    "- pause / resume: only in exceptional cases where the goal pushes you while you genuinely can't progress (e.g. you need a user decision).",
    '- wait: no pushes for "minutes". It ends early when something wakes you: a finished command, a subagent or the user.',
].join("\n")
