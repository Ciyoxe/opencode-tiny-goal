import { beforeEach, describe, expect, it, vi } from "vitest"
import { SessionTree } from "../src/sessions"

describe("SessionTree", () => {
    const parents: Record<string, string> = {}
    let tree: SessionTree

    /** Lets the background parent lookup finish. */
    const learnParents = () => new Promise((resolve) => setTimeout(resolve, 0))

    beforeEach(() => {
        for (const id of Object.keys(parents)) delete parents[id]
        tree = new SessionTree(
            async (id) => ({ data: { id, parentID: parents[id] } }),
            vi.fn(),
            { maxBusyMinutes: 30 },
        )
    })

    describe("rootOf", () => {
        it("treats an unknown session as its own root", () => {
            expect(tree.rootOf("a")).toBe("a")
        })

        it("follows parent links through nested subagents", async () => {
            parents.child = "root"
            parents.grandchild = "child"
            tree.track("child")
            tree.track("grandchild")
            await learnParents()

            expect(tree.rootOf("grandchild")).toBe("root")
        })

        it("accepts a lookup response without a data wrapper", async () => {
            const bare = new SessionTree(async (id) => ({ id, parentID: "root" }), vi.fn(), { maxBusyMinutes: 30 })
            bare.track("child")
            await learnParents()

            expect(bare.rootOf("child")).toBe("root")
        })

        it("takes the parent straight from an event, with no lookup", () => {
            tree.track("child", "root")

            expect(tree.rootOf("child")).toBe("root")
        })

        it("tries a failed lookup again, but not on every event", async () => {
            vi.useFakeTimers()
            try {
                let attempts = 0
                const flaky = new SessionTree(
                    async (id) => {
                        attempts++
                        if (attempts === 1) throw new Error("session not ready")
                        return { data: { id, parentID: "root" } }
                    },
                    vi.fn(),
                    { maxBusyMinutes: 30 },
                )
                const learn = () => vi.advanceTimersByTimeAsync(0)

                flaky.track("child")
                await learn()
                flaky.track("child")
                flaky.track("child")
                await learn()
                expect(attempts).toBe(1)
                expect(flaky.rootOf("child")).toBe("child")

                vi.advanceTimersByTime(5_000)
                flaky.track("child")
                await learn()

                expect(attempts).toBe(2)
                expect(flaky.rootOf("child")).toBe("root")
            } finally {
                vi.useRealTimers()
            }
        })

        it("keeps working when the lookup fails", async () => {
            const log = vi.fn()
            const failing = new SessionTree(() => Promise.reject(new Error("boom")), log, { maxBusyMinutes: 30 })
            failing.track("child")
            await learnParents()

            expect(failing.rootOf("child")).toBe("child")
            expect(log).toHaveBeenCalledWith("session lookup failed", "Error: boom")
        })

        it("forgets a session", async () => {
            parents.child = "root"
            tree.track("child")
            await learnParents()

            tree.forget("child")

            expect(tree.rootOf("child")).toBe("child")
        })
    })

    describe("isBusy", () => {
        it("is false when nothing runs", () => {
            expect(tree.isBusy("root")).toBe(false)
        })

        it("is true while the root session is busy", () => {
            tree.markBusy("root")
            expect(tree.isBusy("root")).toBe(true)

            tree.markIdle("root")
            expect(tree.isBusy("root")).toBe(false)
        })

        it("is true while a subagent is busy, but not for an unrelated root", async () => {
            parents.child = "root"
            tree.track("child")
            await learnParents()

            tree.markBusy("child")

            expect(tree.isBusy("root")).toBe(true)
            expect(tree.isBusy("other-root")).toBe(false)
        })

        it("stops counting a session that stays busy past the cap", () => {
            vi.useFakeTimers()
            try {
                const timed = new SessionTree(async (id) => ({ data: { id } }), vi.fn(), { maxBusyMinutes: 30 })
                timed.markBusy("root")
                expect(timed.isBusy("root")).toBe(true)

                vi.advanceTimersByTime(31 * 60_000)

                expect(timed.isBusy("root")).toBe(false)
            } finally {
                vi.useRealTimers()
            }
        })

        it("a fresh step extends the busy window", () => {
            vi.useFakeTimers()
            try {
                const timed = new SessionTree(async (id) => ({ data: { id } }), vi.fn(), { maxBusyMinutes: 30 })
                timed.markBusy("root")
                vi.advanceTimersByTime(20 * 60_000)
                timed.markBusy("root")
                vi.advanceTimersByTime(20 * 60_000)

                expect(timed.isBusy("root")).toBe(true)

                vi.advanceTimersByTime(11 * 60_000)

                expect(timed.isBusy("root")).toBe(false)
            } finally {
                vi.useRealTimers()
            }
        })
    })

    describe("running shells", () => {
        it("tells when the newest running command started", () => {
            vi.useFakeTimers()
            try {
                expect(tree.lastShellStartedAt("root")).toBeUndefined()

                tree.shellStarted("sh1", "root")
                vi.advanceTimersByTime(60_000)
                const secondStart = Date.now()
                tree.shellStarted("sh2", "root")

                expect(tree.lastShellStartedAt("root")).toBe(secondStart)
            } finally {
                vi.useRealTimers()
            }
        })

        it("forgets a command when it ends", () => {
            tree.shellStarted("sh1", "root")
            tree.shellEnded("sh1")

            expect(tree.lastShellStartedAt("root")).toBeUndefined()
        })

        it("does not count a command as busy work", () => {
            tree.shellStarted("sh1", "root")

            expect(tree.isBusy("root")).toBe(false)
        })

        it("counts a command of a subagent for the root", async () => {
            parents.child = "root"
            tree.track("child")
            await learnParents()

            tree.shellStarted("sh1", "child")

            expect(tree.lastShellStartedAt("root")).toBeDefined()
            expect(tree.lastShellStartedAt("other-root")).toBeUndefined()
        })
    })
})
