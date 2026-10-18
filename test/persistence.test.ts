import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakeStorage, PROJECT_DIRECTORY, startPlugin, type FakePlugin } from "./fake-opencode"

const ROOT = "root"
const SETTLE_MS = 600

const flush = () => vi.advanceTimersByTimeAsync(0)

async function endTurn(plugin: FakePlugin, sessionID = ROOT) {
    plugin.emit("session.step.started", { sessionID })
    plugin.emit("session.step.ended", { sessionID, finish: "stop" })
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
}

/** Starts a new plugin instance on the same storage, as after restarting opencode. */
async function restart(storage: FakeStorage, directory = PROJECT_DIRECTORY, options = {}) {
    return startPlugin(options, { storage, directory })
}

let storage: FakeStorage

beforeEach(() => {
    vi.useFakeTimers()
    storage = new FakeStorage()
})

afterEach(() => {
    vi.useRealTimers()
})

describe("saving goals", () => {
    it("saves a goal when it is set", async () => {
        const plugin = await startPlugin({}, { storage })

        await plugin.runCommand(ROOT, "write the docs")
        await flush()

        expect(storage.goalsOf(PROJECT_DIRECTORY)).toEqual({ [ROOT]: { text: "write the docs", status: "active" } })
    })

    it("saves pausing, resuming and rewording", async () => {
        const plugin = await startPlugin({}, { storage })
        await plugin.runCommand(ROOT, "write the docs")

        await plugin.callGoalTool(ROOT, { action: "pause" })
        await flush()
        expect(storage.goalsOf(PROJECT_DIRECTORY)).toEqual({ [ROOT]: { text: "write the docs", status: "paused" } })

        await plugin.callGoalTool(ROOT, { action: "resume" })
        await plugin.callGoalTool(ROOT, { action: "set", text: "write the docs and the changelog" })
        await flush()
        expect(storage.goalsOf(PROJECT_DIRECTORY)).toEqual({
            [ROOT]: { text: "write the docs and the changelog", status: "active" },
        })
    })

    it("forgets a goal that is done, cleared, or whose session is deleted", async () => {
        const plugin = await startPlugin({}, { storage })
        await plugin.runCommand("a", "first")
        await plugin.runCommand("b", "second")
        await plugin.runCommand("c", "third")

        await plugin.callGoalTool("a", { action: "done" })
        await plugin.runCommand("b", "clear")
        plugin.emit("session.deleted", { sessionID: "c" })
        await flush()

        expect(storage.goalsOf(PROJECT_DIRECTORY)).toEqual({})
    })

    it("saves the pause made by the circuit breaker", async () => {
        const plugin = await startPlugin({ maxUnansweredReminders: 1 }, { storage })
        await plugin.runCommand(ROOT, "write the docs")

        await endTurn(plugin)
        await endTurn(plugin)
        await flush()

        expect(storage.goalsOf(PROJECT_DIRECTORY)).toEqual({ [ROOT]: { text: "write the docs", status: "paused" } })
    })

    it("does not save anything that is not a goal change", async () => {
        const plugin = await startPlugin({}, { storage })
        await plugin.runCommand(ROOT, "write the docs")
        await flush()
        const saved = JSON.stringify(storage.goalsOf(PROJECT_DIRECTORY))

        await plugin.callGoalTool(ROOT, { action: "wait", minutes: 5 })
        plugin.reportToolCall(ROOT)
        await endTurn(plugin)

        expect(JSON.stringify(storage.goalsOf(PROJECT_DIRECTORY))).toBe(saved)
    })
})

describe("after a restart", () => {
    it("brings the goal back and keeps showing it to the agent", async () => {
        const before = await startPlugin({}, { storage })
        await before.runCommand(ROOT, "write the docs")
        await flush()

        const after = await restart(storage)

        expect(after.systemEntriesFor(ROOT)[0]).toContain("Active goal (set by the user): write the docs")
        await after.runCommand(ROOT, "status")
        expect(after.sentNotes.map((note) => note.text)).toEqual(["[goal] Goal (active): write the docs"])
    })

    it("keeps reminding once the agent's turn ends", async () => {
        const before = await startPlugin({}, { storage })
        await before.runCommand(ROOT, "write the docs")
        await flush()

        const after = await restart(storage)
        await endTurn(after)

        expect(after.sentPrompts.map((prompt) => prompt.text)).toEqual([
            "[goal] Not done yet: write the docs. Continue, or call goal(done) if it's achieved.",
        ])
    })

    it("does not wake any session by itself", async () => {
        const before = await startPlugin({}, { storage })
        await before.runCommand(ROOT, "write the docs")
        await flush()

        const after = await restart(storage)
        await vi.advanceTimersByTimeAsync(60 * 60_000)

        expect(after.sentPrompts).toEqual([])
        expect(after.sentNotes).toEqual([])
    })

    it("keeps a paused goal paused", async () => {
        const before = await startPlugin({}, { storage })
        await before.runCommand(ROOT, "write the docs")
        await before.callGoalTool(ROOT, { action: "pause" })
        await flush()

        const after = await restart(storage)
        await endTurn(after)

        expect(after.sentPrompts).toEqual([])
        expect(after.systemEntriesFor(ROOT)).toEqual([])
        await after.runCommand(ROOT, "resume")
        await endTurn(after)
        expect(after.sentPrompts).toHaveLength(1)
    })

    it("does not bring back a finished goal", async () => {
        const before = await startPlugin({}, { storage })
        await before.runCommand(ROOT, "write the docs")
        await before.callGoalTool(ROOT, { action: "done" })
        await flush()

        const after = await restart(storage)
        await endTurn(after)

        expect(after.sentPrompts).toEqual([])
    })

    it("starts counting ignored reminders from zero", async () => {
        const before = await startPlugin({ maxUnansweredReminders: 2 }, { storage })
        await before.runCommand(ROOT, "write the docs")
        await endTurn(before)
        await endTurn(before)
        await flush()

        const after = await restart(storage, PROJECT_DIRECTORY, { maxUnansweredReminders: 2 })
        await endTurn(after)
        await endTurn(after)

        expect(after.sentPrompts).toHaveLength(2)
        expect(after.sentNotes).toEqual([])
    })
})

describe("projects", () => {
    it("keeps the goals of different projects apart", async () => {
        const first = await startPlugin({}, { storage, directory: "/project-a" })
        const second = await startPlugin({}, { storage, directory: "/project-b" })

        await first.runCommand("a1", "goal of a")
        await second.runCommand("b1", "goal of b")
        await flush()

        expect(storage.goalsOf("/project-a")).toEqual({ a1: { text: "goal of a", status: "active" } })
        expect(storage.goalsOf("/project-b")).toEqual({ b1: { text: "goal of b", status: "active" } })

        const restartedA = await restart(storage, "/project-a")
        expect(restartedA.systemEntriesFor("b1")).toEqual([])
        expect(restartedA.systemEntriesFor("a1")).toHaveLength(1)
    })
})

describe("when storage misbehaves", () => {
    it("starts without goals if reading fails", async () => {
        storage.failReads = true

        const plugin = await startPlugin({}, { storage })
        await plugin.runCommand(ROOT, "write the docs")
        await endTurn(plugin)

        expect(plugin.sentPrompts.map((prompt) => prompt.text)[1]).toContain("Not done yet")
    })

    it("keeps working if writing fails", async () => {
        storage.failWrites = true
        const plugin = await startPlugin({}, { storage })

        await plugin.runCommand(ROOT, "write the docs")
        await plugin.callGoalTool(ROOT, { action: "pause" })
        await flush()

        await plugin.runCommand(ROOT, "status")
        expect(plugin.sentNotes.at(-1)!.text).toBe("[goal] Goal (paused): write the docs")
    })

    it.each([null, "text", 42, [], { x: 1 }, { s: { text: 5, status: "active" } }, { s: { text: "t", status: "weird" } }])(
        "ignores a damaged save: %j",
        async (damaged) => {
            storage.values.set(JSON.stringify(["opencode-tiny-goal", "goals", PROJECT_DIRECTORY]), damaged)

            const plugin = await startPlugin({}, { storage })
            await endTurn(plugin)

            expect(plugin.sentPrompts).toEqual([])
            expect(plugin.systemEntriesFor("s")).toEqual([])
        },
    )

    it("keeps valid goals next to a damaged one", async () => {
        storage.values.set(JSON.stringify(["opencode-tiny-goal", "goals", PROJECT_DIRECTORY]), {
            good: { text: "fine", status: "active" },
            bad: { text: 5 },
        })

        const plugin = await startPlugin({}, { storage })

        expect(plugin.systemEntriesFor("good")).toHaveLength(1)
        expect(plugin.systemEntriesFor("bad")).toEqual([])
    })
})
