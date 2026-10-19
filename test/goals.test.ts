import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GoalBook } from "../src/goals"

const MAX_WAIT_MINUTES = 30
const SESSION = "root"

describe("GoalBook", () => {
    let goals: GoalBook

    beforeEach(() => {
        vi.useFakeTimers()
        goals = new GoalBook(MAX_WAIT_MINUTES)
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    describe("starting and describing", () => {
        it("reports no goal before one is set", () => {
            expect(goals.apply(SESSION, "status")).toBe("No goal.")
            expect(goals.has(SESSION)).toBe(false)
        })

        it("starts an active goal", () => {
            goals.start(SESSION, "ship it")

            expect(goals.get(SESSION)).toMatchObject({ text: "ship it", status: "active" })
            expect(goals.get(SESSION)!.haltedBy).toBeUndefined()
            expect(goals.apply(SESSION, "status")).toBe("Goal (active): ship it")
        })

        it("replaces an existing goal and resets its state", () => {
            goals.start(SESSION, "first")
            goals.get(SESSION)!.haltedBy = "failure"

            goals.start(SESSION, "second")

            expect(goals.get(SESSION)).toMatchObject({ text: "second" })
            expect(goals.get(SESSION)!.haltedBy).toBeUndefined()
        })
    })

    describe("set", () => {
        it("requires non-blank text", () => {
            expect(goals.apply(SESSION, "set")).toBe("Error: text is required.")
            expect(goals.apply(SESSION, "set", { text: "   " })).toBe("Error: text is required.")
            expect(goals.has(SESSION)).toBe(false)
        })

        it("creates a goal when there is none", () => {
            expect(goals.apply(SESSION, "set", { text: " new goal " })).toBe("Goal set.")
            expect(goals.get(SESSION)?.text).toBe("new goal")
        })

        it("rewords an existing goal without resetting its progress", () => {
            goals.start(SESSION, "vague")
            goals.get(SESSION)!.unansweredReminders = 2

            expect(goals.apply(SESSION, "set", { text: "precise" })).toBe("Goal updated.")

            expect(goals.get(SESSION)).toMatchObject({ text: "precise", unansweredReminders: 2 })
        })
    })

    describe("finishing", () => {
        it.each(["done", "clear"] as const)("%s removes the goal", (action) => {
            goals.start(SESSION, "work")

            expect(goals.apply(SESSION, action)).toBe("Goal finished.")
            expect(goals.has(SESSION)).toBe(false)
        })

        it.each(["done", "clear", "pause", "resume", "wait"] as const)("%s without a goal says so", (action) => {
            expect(goals.apply(SESSION, action)).toBe("No goal.")
        })
    })

    describe("pause and resume", () => {
        it("pauses and resumes", () => {
            goals.start(SESSION, "work")

            expect(goals.apply(SESSION, "pause")).toBe("Goal paused.")
            expect(goals.get(SESSION)?.status).toBe("paused")

            expect(goals.apply(SESSION, "resume")).toBe("Goal resumed.")
            expect(goals.get(SESSION)?.status).toBe("active")
        })

        it("resuming clears the wait and the unanswered reminders", () => {
            goals.start(SESSION, "work")
            const goal = goals.get(SESSION)!
            goal.waitUntil = Date.now() + 1000
            goal.reminderPending = true
            goal.unansweredReminders = 4

            goals.apply(SESSION, "resume")

            expect(goal).toMatchObject({ waitUntil: undefined, reminderPending: false, unansweredReminders: 0 })
        })
    })

    describe("wait", () => {
        beforeEach(() => goals.start(SESSION, "work"))

        it("defaults to the maximum wait", () => {
            expect(goals.apply(SESSION, "wait")).toBe(`Not pushing for ${MAX_WAIT_MINUTES} min.`)
            expect(goals.get(SESSION)!.waitUntil).toBe(Date.now() + MAX_WAIT_MINUTES * 60_000)
        })

        it("honours a shorter request", () => {
            goals.apply(SESSION, "wait", { minutes: 5 })

            expect(goals.get(SESSION)!.waitUntil).toBe(Date.now() + 5 * 60_000)
        })

        it("caps a longer request at the maximum", () => {
            expect(goals.apply(SESSION, "wait", { minutes: 999 })).toBe(`Not pushing for ${MAX_WAIT_MINUTES} min.`)
        })

        it("rejects a request that is not a positive number", () => {
            for (const minutes of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
                expect(goals.apply(SESSION, "wait", { minutes })).toBe("Error: minutes must be a positive number.")
            }
            expect(goals.get(SESSION)!.waitUntil).toBeUndefined()
        })
    })

    describe("events from the session", () => {
        it("a user message clears halting, waiting and reminder counts", () => {
            goals.start(SESSION, "work")
            const goal = goals.get(SESSION)!
            Object.assign(goal, { haltedBy: "user", waitUntil: 123, reminderPending: true, unansweredReminders: 3 })

            goals.onUserMessage(SESSION)

            expect(goal).toMatchObject({ haltedBy: undefined, waitUntil: undefined, reminderPending: false, unansweredReminders: 0 })
        })

        it("counts tool calls only for sessions that have a goal", () => {
            goals.start(SESSION, "work")

            goals.onToolCall(SESSION)
            goals.onToolCall(SESSION)
            goals.onToolCall("someone-else")

            expect(goals.get(SESSION)!.toolCallsSinceReminder).toBe(2)
        })
    })
})
