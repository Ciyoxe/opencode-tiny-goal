import type { GoalBook, SavedGoal } from "./goals"
import type { Logger, PluginContext } from "./runtime"

type SavedGoals = Record<string, SavedGoal>

const STORAGE_NAMESPACE = "opencode-tiny-goal"

/** Keeps the goals of one project in opencode's storage, so they survive a restart. */
export class GoalPersistence {
    private readonly key: string[]
    private saved: SavedGoals = {}
    private writes: Promise<unknown> = Promise.resolve()

    constructor(
        private readonly storage: PluginContext["storage"],
        projectDirectory: string,
        private readonly log: Logger,
    ) {
        this.key = [STORAGE_NAMESPACE, "goals", projectDirectory]
    }

    /** Reads the saved goals into the goal book. A broken or missing save is ignored. */
    async restoreInto(goals: GoalBook): Promise<void> {
        try {
            this.saved = this.parse(await this.storage.get(this.key))
        } catch (error) {
            this.log("loading saved goals failed", String(error))
            return
        }
        for (const [sessionId, goal] of Object.entries(this.saved)) goals.restore(sessionId, goal)
    }

    /** Remembers a goal's new state, or forgets the goal when `goal` is undefined. */
    update(sessionId: string, goal: SavedGoal | undefined): void {
        if (goal) this.saved[sessionId] = goal
        else delete this.saved[sessionId]
        this.write({ ...this.saved })
    }

    /** Writes happen one after another so an older snapshot never overwrites a newer one. */
    private write(snapshot: SavedGoals): void {
        this.writes = this.writes
            .then(() => this.storage.set(this.key, snapshot))
            .catch((error) => this.log("saving goals failed", String(error)))
    }

    private parse(stored: unknown): SavedGoals {
        if (typeof stored !== "object" || stored === null) return {}
        const valid = Object.entries(stored).filter(([, goal]) => isSavedGoal(goal))
        return Object.fromEntries(valid)
    }
}

function isSavedGoal(value: unknown): value is SavedGoal {
    if (typeof value !== "object" || value === null) return false
    const { text, status } = value as Partial<SavedGoal>
    return typeof text === "string" && (status === "active" || status === "paused")
}
