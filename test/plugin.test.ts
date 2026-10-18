import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startPlugin, type FakePlugin } from "./fake-opencode"

const ROOT = "root"
const SETTLE_MS = 600
const MAX_UNANSWERED_REMINDERS = 5

let plugin: FakePlugin

/** Lets queued events reach their handlers. */
const flush = () => vi.advanceTimersByTimeAsync(0)

/** The root session finishes a turn and the plugin gets time to decide. */
async function endTurn(sessionID = ROOT, finish = "stop") {
    plugin.emit("session.step.started", { sessionID })
    plugin.emit("session.step.ended", { sessionID, finish })
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
}

const reminderTexts = () => plugin.sentPrompts.map((prompt) => prompt.text).filter((text) => text.startsWith("[goal]"))

beforeEach(async () => {
    vi.useFakeTimers()
    plugin = await startPlugin()
})

afterEach(() => {
    vi.useRealTimers()
})

describe("/goal command", () => {
    it("sets the goal and prompts the agent to start", async () => {
        await plugin.runCommand(ROOT, " write the docs ", "queue")

        expect(plugin.sentPrompts).toEqual([{ sessionID: ROOT, text: "Goal: write the docs", delivery: "queue" }])
    })

    it("control words answer with a note and never prompt the model", async () => {
        await plugin.runCommand(ROOT, "write the docs")
        plugin.sentPrompts.length = 0

        await plugin.runCommand(ROOT, "status")
        await plugin.runCommand(ROOT, "pause")
        await plugin.runCommand(ROOT, "status")
        await plugin.runCommand(ROOT, "resume")
        await plugin.runCommand(ROOT, "clear")

        expect(plugin.sentNotes.map((note) => note.text)).toEqual([
            "[goal] Goal (active): write the docs",
            "[goal] Goal paused.",
            "[goal] Goal (paused): write the docs",
            "[goal] Goal resumed.",
            "[goal] Goal finished.",
        ])
        expect(plugin.sentPrompts).toEqual([])
    })

    it("a bare /goal shows the status", async () => {
        await plugin.runCommand(ROOT, "")

        expect(plugin.sentNotes.map((note) => note.text)).toEqual(["[goal] No goal."])
    })
})

describe("reminders", () => {
    beforeEach(async () => {
        await plugin.runCommand(ROOT, "write the docs")
        plugin.sentPrompts.length = 0
    })

    it("reminds the agent when its turn ends", async () => {
        await endTurn()

        expect(plugin.sentPrompts).toEqual([
            {
                sessionID: ROOT,
                text: "[goal] Not done yet: write the docs. Continue, or call goal(done) if it's achieved.",
                delivery: "queue",
            },
        ])
    })

    it("does not remind while the agent is still going through tool-call steps", async () => {
        await endTurn(ROOT, "tool-calls")

        expect(plugin.sentPrompts).toEqual([])
    })

    it("waits a moment, since new work may start right after a turn", async () => {
        plugin.emit("session.step.started", { sessionID: ROOT })
        plugin.emit("session.step.ended", { sessionID: ROOT, finish: "stop" })
        await vi.advanceTimersByTimeAsync(100)
        expect(plugin.sentPrompts).toEqual([])

        plugin.emit("session.step.started", { sessionID: ROOT })
        await vi.advanceTimersByTimeAsync(SETTLE_MS)

        expect(plugin.sentPrompts).toEqual([])
    })

    it("does nothing without a goal", async () => {
        await plugin.runCommand(ROOT, "clear")

        await endTurn()

        expect(plugin.sentPrompts).toEqual([])
    })

    it("stops after the goal is done", async () => {
        await plugin.callGoalTool(ROOT, { action: "done" })

        await endTurn()

        expect(plugin.sentPrompts).toEqual([])
    })

    it("stays quiet while the goal is paused and resumes when it is resumed", async () => {
        await plugin.callGoalTool(ROOT, { action: "pause" })
        await endTurn()
        expect(plugin.sentPrompts).toEqual([])

        await plugin.callGoalTool(ROOT, { action: "resume" })
        await endTurn()

        expect(reminderTexts()).toHaveLength(1)
    })

    it("uses the reworded goal text", async () => {
        await plugin.callGoalTool(ROOT, { action: "set", text: "write the docs and the changelog" })

        await endTurn()

        expect(reminderTexts()[0]).toContain("write the docs and the changelog")
    })

    it("a session without a goal is left alone, even next to one that has a goal", async () => {
        await endTurn("another-root")

        expect(plugin.sentPrompts).toEqual([])
    })
})

describe("background work", () => {
    beforeEach(async () => {
        await plugin.runCommand(ROOT, "write the docs")
        plugin.sentPrompts.length = 0
    })

    it("does not remind while a subagent is working, then reminds once it is done", async () => {
        plugin.setParent("child", ROOT)
        plugin.emit("session.step.started", { sessionID: "child" })
        await flush()

        await endTurn()
        expect(plugin.sentPrompts).toEqual([])

        await endTurn("child")
        expect(reminderTexts()).toHaveLength(1)
        expect(plugin.sentPrompts[0]!.sessionID).toBe(ROOT)
    })

    it("does not remind while a shell command is running, then reminds when it exits", async () => {
        plugin.emit("session.tool.progress", { sessionID: ROOT, metadata: { shellID: "sh1" } })
        plugin.emit("shell.created", { info: { id: "sh1" } })
        await flush()

        await endTurn()
        expect(plugin.sentPrompts).toEqual([])

        plugin.emit("shell.exited", { id: "sh1" })
        await vi.advanceTimersByTimeAsync(SETTLE_MS)
        expect(reminderTexts()).toHaveLength(1)
    })

    it("ignores shell commands that no tool call of this session started", async () => {
        plugin.emit("shell.created", { info: { id: "unrelated" } })
        await flush()

        await endTurn()

        expect(reminderTexts()).toHaveLength(1)
    })
})

describe("waiting", () => {
    beforeEach(async () => {
        await plugin.runCommand(ROOT, "write the docs")
        plugin.sentPrompts.length = 0
    })

    it("holds reminders back until the wait is over, then says so", async () => {
        expect(await plugin.callGoalTool(ROOT, { action: "wait", minutes: 10 })).toBe("Not pushing for 10 min.")

        await endTurn()
        await vi.advanceTimersByTimeAsync(9 * 60_000)
        expect(plugin.sentPrompts).toEqual([])

        await vi.advanceTimersByTimeAsync(60_000)
        expect(reminderTexts()).toEqual([
            "[goal] Wait is over, goal is still active: write the docs. Check on what you were waiting for and continue.",
        ])
    })

    it("caps the wait at 30 minutes", async () => {
        expect(await plugin.callGoalTool(ROOT, { action: "wait", minutes: 999 })).toBe("Not pushing for 30 min.")
    })

    it("a message from the user ends the wait", async () => {
        await plugin.callGoalTool(ROOT, { action: "wait", minutes: 10 })

        plugin.emit("session.inbox.enqueued", { sessionID: ROOT, item: { type: "user", payload: { text: "any news?" } } })
        await flush()
        await endTurn()

        expect(reminderTexts()).toHaveLength(1)
    })

    it("pausing during a wait cancels the wake-up", async () => {
        await plugin.callGoalTool(ROOT, { action: "wait", minutes: 10 })
        await plugin.callGoalTool(ROOT, { action: "pause" })

        await vi.advanceTimersByTimeAsync(11 * 60_000)

        expect(plugin.sentPrompts).toEqual([])
    })
})

describe("reminders that get ignored", () => {
    beforeEach(async () => {
        await plugin.runCommand(ROOT, "write the docs")
        plugin.sentPrompts.length = 0
    })

    it("pauses the goal after repeated reminders that lead to no tool call", async () => {
        for (let turn = 0; turn <= MAX_UNANSWERED_REMINDERS; turn++) await endTurn()

        expect(reminderTexts()).toHaveLength(MAX_UNANSWERED_REMINDERS)
        expect(plugin.sentNotes.at(-1)!.text).toBe(
            "[goal] Paused: 5 pushes in a row without progress. The user can /goal resume.",
        )

        await endTurn()
        expect(reminderTexts()).toHaveLength(MAX_UNANSWERED_REMINDERS)
    })

    it("a tool call after a reminder counts as progress", async () => {
        for (let turn = 0; turn < MAX_UNANSWERED_REMINDERS * 2; turn++) {
            await endTurn()
            plugin.reportToolCall(ROOT)
        }

        expect(reminderTexts()).toHaveLength(MAX_UNANSWERED_REMINDERS * 2)
        expect(plugin.sentNotes).toEqual([])
    })

    it("calling the goal tool itself is not progress", async () => {
        for (let turn = 0; turn <= MAX_UNANSWERED_REMINDERS; turn++) {
            await endTurn()
            plugin.reportToolCall(ROOT, "goal")
        }

        expect(plugin.sentNotes).toHaveLength(1)
    })

    it("tool calls made by a subagent count for the root goal", async () => {
        plugin.setParent("child", ROOT)
        plugin.emit("session.step.started", { sessionID: "child" })
        await flush()
        plugin.emit("session.step.ended", { sessionID: "child", finish: "stop" })
        await flush()

        for (let turn = 0; turn <= MAX_UNANSWERED_REMINDERS; turn++) {
            await endTurn()
            plugin.reportToolCall("child")
        }

        expect(plugin.sentNotes).toEqual([])
    })

    it("the limit can be configured", async () => {
        plugin = await startPlugin({ maxStrikes: 2 })
        await plugin.runCommand(ROOT, "write the docs")

        for (let turn = 0; turn < 4; turn++) await endTurn()

        expect(reminderTexts()).toHaveLength(2)
        expect(plugin.sentNotes).toHaveLength(1)
    })
})

describe("failures and interruptions", () => {
    beforeEach(async () => {
        await plugin.runCommand(ROOT, "write the docs")
        plugin.sentPrompts.length = 0
    })

    it.each(["session.execution.failed", "session.execution.interrupted", "session.step.failed"])(
        "%s stops reminders until the user writes again",
        async (eventType) => {
            plugin.emit(eventType, { sessionID: ROOT })
            await flush()
            await endTurn()
            expect(plugin.sentPrompts).toEqual([])

            plugin.emit("session.inbox.enqueued", { sessionID: ROOT, item: { type: "user", payload: { text: "try again" } } })
            await flush()
            await endTurn()

            expect(reminderTexts()).toHaveLength(1)
        },
    )

    it("the plugin's own reminder does not count as a user message", async () => {
        plugin.emit("session.execution.failed", { sessionID: ROOT })
        plugin.emit("session.inbox.enqueued", { sessionID: ROOT, item: { type: "user", payload: { text: "[goal] Not done yet" } } })
        await flush()

        await endTurn()

        expect(plugin.sentPrompts).toEqual([])
    })

    it("notes and other non-user inbox items do not count as a user message", async () => {
        plugin.emit("session.execution.failed", { sessionID: ROOT })
        plugin.emit("session.inbox.enqueued", { sessionID: ROOT, item: { type: "synthetic", payload: { text: "context" } } })
        await flush()

        await endTurn()

        expect(plugin.sentPrompts).toEqual([])
    })
})

describe("events", () => {
    it("ignores events from other projects", async () => {
        await plugin.runCommand(ROOT, "write the docs")
        plugin.sentPrompts.length = 0

        plugin.emit("session.step.started", { sessionID: ROOT }, "/somewhere/else")
        plugin.emit("session.step.ended", { sessionID: ROOT, finish: "stop" }, "/somewhere/else")
        await vi.advanceTimersByTimeAsync(SETTLE_MS)

        expect(plugin.sentPrompts).toEqual([])
    })

    it("survives unknown events and events without data", async () => {
        plugin.emit("something.new", { sessionID: ROOT })
        plugin.emit("session.deleted", {})
        await flush()

        await plugin.runCommand(ROOT, "write the docs")
        plugin.sentPrompts.length = 0
        await endTurn()

        expect(reminderTexts()).toHaveLength(1)
    })

    it("forgets the goal of a deleted session", async () => {
        await plugin.runCommand(ROOT, "write the docs")
        plugin.sentPrompts.length = 0

        plugin.emit("session.deleted", { sessionID: ROOT })
        await flush()
        await endTurn()

        expect(plugin.sentPrompts).toEqual([])
    })
})

describe("goal tool", () => {
    it("says so when there is no goal", async () => {
        expect(await plugin.callGoalTool(ROOT, { action: "done" })).toBe("There is no active goal.")
    })

    it("works on the root goal when called from a subagent", async () => {
        await plugin.runCommand(ROOT, "write the docs")
        plugin.setParent("child", ROOT)
        plugin.emit("session.step.started", { sessionID: "child" })
        await flush()

        expect(await plugin.callGoalTool("child", { action: "done" })).toBe("Goal finished.")
    })
})

describe("system prompt", () => {
    it("shows the active goal to the session that owns it", async () => {
        await plugin.runCommand(ROOT, "write the docs")

        const [line] = plugin.systemEntriesFor(ROOT)

        expect(line).toContain("Active goal (set by the user): write the docs")
        expect(line).toContain("goal(done)")
    })

    it("shows nothing without a goal or while paused", async () => {
        expect(plugin.systemEntriesFor(ROOT)).toEqual([])

        await plugin.runCommand(ROOT, "write the docs")
        await plugin.callGoalTool(ROOT, { action: "pause" })

        expect(plugin.systemEntriesFor(ROOT)).toEqual([])
    })

    it("does not show the goal to subagents", async () => {
        await plugin.runCommand(ROOT, "write the docs")
        plugin.setParent("child", ROOT)
        plugin.emit("session.step.started", { sessionID: "child" })
        await flush()

        expect(plugin.systemEntriesFor("child")).toEqual([])
    })
})
