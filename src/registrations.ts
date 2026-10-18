import type { GoalAction } from "./goals"
import type { CommandInvocation, PluginContext, ToolCallContext } from "./runtime"
import type { Services } from "./services"
import { MESSAGE_PREFIX, systemLine, TOOL_DESCRIPTION } from "./texts"

const GOAL_TOOL_NAME = "goal"
const GOAL_TOOL_ACTIONS: readonly GoalAction[] = ["done", "set", "pause", "resume", "wait"]
const GOAL_TOOL_INPUT = {
    type: "object",
    properties: {
        action: { type: "string", enum: GOAL_TOOL_ACTIONS },
        text: { type: "string", description: "New goal text (for set)" },
        minutes: { type: "number", description: "Minutes to wait (for wait)" },
    },
    required: ["action"],
    additionalProperties: false,
}
const CONTROL_WORDS: readonly string[] = ["pause", "resume", "clear", "status"]

/** Applies a control action and keeps the wake-up timer in line with the result. */
function applyAction(services: Services, rootId: string, action: GoalAction, input: { text?: string; minutes?: number } = {}): string {
    const result = services.goals.apply(rootId, action, input)
    services.reminders.syncWakeTimer(rootId)
    return result
}

/** `/goal <text>` sets a goal; `/goal pause|resume|clear|status` controls it without a model turn. */
export async function registerGoalCommand(context: PluginContext, services: Services): Promise<void> {
    const run = async (invocation: CommandInvocation) => {
        const argument = invocation.prompt.text.trim()
        const rootId = services.sessions.rootOf(invocation.sessionID)

        if (argument === "" || CONTROL_WORDS.includes(argument)) {
            const result = applyAction(services, rootId, (argument || "status") as GoalAction)
            await services.reminders.note(invocation.sessionID, `${MESSAGE_PREFIX} ${result}`)
            return
        }

        services.goals.start(rootId, argument)
        services.reminders.syncWakeTimer(rootId)
        await context.session.prompt({
            ...invocation.prompt,
            sessionID: invocation.sessionID,
            text: `Goal: ${argument}`,
            delivery: invocation.delivery,
        })
    }

    await context.command.transform((draft) =>
        draft.add({
            name: "goal",
            description: "Set or control the goal: /goal <text> | pause | resume | clear | status",
            execute: run,
        }),
    )
}

/** The `goal` tool lets the agent finish, reword, pause or wait on its own goal. */
export async function registerGoalTool(context: PluginContext, services: Services): Promise<void> {
    const run = async (input: { action: GoalAction; text?: string; minutes?: number }, call: ToolCallContext) => {
        const rootId = services.sessions.rootOf(call.sessionID)
        if (!services.goals.has(rootId)) return { content: "There is no active goal." }
        return { content: applyAction(services, rootId, input.action, input) }
    }

    await context.tool.transform((draft) =>
        draft.add({
            name: GOAL_TOOL_NAME,
            options: { codemode: false },
            description: TOOL_DESCRIPTION,
            input: GOAL_TOOL_INPUT,
            execute: run,
        }),
    )
}

/** Counts the agent's tool calls, and shows the active goal to the root agent on every turn. */
export async function registerHooks(context: PluginContext, services: Services): Promise<void> {
    await context.tool.hook("execute.before", (call) => {
        if (call.tool === GOAL_TOOL_NAME) return
        services.goals.onToolCall(services.sessions.rootOf(call.sessionID))
    })

    await context.session.hook("context", (turn) => {
        const isRootSession = services.sessions.rootOf(turn.sessionID) === turn.sessionID
        const goal = services.goals.get(turn.sessionID)
        if (!isRootSession || goal?.status !== "active") return
        turn.system.push({ type: "text", text: systemLine(goal.text) })
    })
}
