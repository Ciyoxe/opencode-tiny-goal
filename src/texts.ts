export const systemLine = (text: string) =>
  `Active goal (set by the user): ${text}
Keep working until it is fully achieved, then call goal(done).
Don't stop to ask whether to continue. Refine the goal with goal(set, text) if it turns out unclear or wrong.`

export const nudge = (text: string) =>
  `[goal] Not done yet: ${text}. Continue, or call goal(done) if it's achieved.`

export const waitEnded = (text: string) =>
  `[goal] Wait is over, goal is still active: ${text}. Check on what you were waiting for and continue.`

export const toolDescription = `Manage the user's active goal.
- done: the goal is achieved.
- set: replace the goal text with a clearer one (requires "text").
- pause / resume: only in exceptional cases where the goal pushes you while you genuinely can't progress (e.g. you need a user decision). Not needed while a command or subagent is running.
- wait: only if you wait on something the plugin can't see; no pushes for "minutes".`
