import { beforeEach, describe, expect, it, vi } from "vitest"
import { SessionTree } from "../src/sessions"

describe("SessionTree", () => {
    const parents: Record<string, string> = {}
    let tree: SessionTree

    /** Lets the background parent lookup finish. */
    const learnParents = () => new Promise((resolve) => setTimeout(resolve, 0))

    beforeEach(() => {
        for (const id of Object.keys(parents)) delete parents[id]
        tree = new SessionTree(async (id) => ({ data: { id, parentID: parents[id] } }), vi.fn())
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
            const bare = new SessionTree(async (id) => ({ id, parentID: "root" }), vi.fn())
            bare.track("child")
            await learnParents()

            expect(bare.rootOf("child")).toBe("root")
        })

        it("keeps working when the lookup fails", async () => {
            const log = vi.fn()
            const failing = new SessionTree(() => Promise.reject(new Error("boom")), log)
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

    describe("hasActiveWork", () => {
        it("is false when nothing runs", () => {
            expect(tree.hasActiveWork("root")).toBe(false)
        })

        it("is true while the root session is busy", () => {
            tree.markBusy("root")
            expect(tree.hasActiveWork("root")).toBe(true)

            tree.markIdle("root")
            expect(tree.hasActiveWork("root")).toBe(false)
        })

        it("is true while a subagent is busy, but not for an unrelated root", async () => {
            parents.child = "root"
            tree.track("child")
            await learnParents()

            tree.markBusy("child")

            expect(tree.hasActiveWork("root")).toBe(true)
            expect(tree.hasActiveWork("other-root")).toBe(false)
        })

        it("is true while a shell command started by the session runs", () => {
            tree.linkShell("sh1", "root")
            tree.shellStarted("sh1")
            expect(tree.hasActiveWork("root")).toBe(true)

            expect(tree.shellExited("sh1")).toBe("root")
            expect(tree.hasActiveWork("root")).toBe(false)
        })

        it("ignores shells that no tool call claimed", () => {
            tree.shellStarted("stranger")

            expect(tree.hasActiveWork("root")).toBe(false)
            expect(tree.shellExited("stranger")).toBeUndefined()
        })
    })
})
