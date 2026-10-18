/** Prefix of every message the plugin sends, so its own messages can be told apart from the user's. */
export const MESSAGE_PREFIX = "[goal]"

export function systemLine(goalText: string): string {
    return [
        `Active goal (set by the user): ${goalText}`,
        "Keep working until it is fully achieved, then call goal(done).",
        "Don't stop to ask whether to continue. Refine the goal with goal(set, text) if it turns out unclear or wrong.",
    ].join("\n")
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
    "- pause / resume: only in exceptional cases where the goal pushes you while you genuinely can't progress (e.g. you need a user decision). Not needed while a command or subagent is running.",
    '- wait: only if you wait on something the plugin can\'t see; no pushes for "minutes".',
].join("\n")
