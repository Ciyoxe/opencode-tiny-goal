import { appendFileSync } from "node:fs"
import { Schema } from "effect"
import * as texts from "./texts"

// The published v2 types lag behind the runtime context, so this is the subset
// of the runtime surface the plugin relies on (verified by probing opencode 2.0.31).
type Ev = { type: string; data: any; location?: { directory: string } }
type Ctx = {
  options: Record<string, any>
  location: { directory: string; project: { directory: string } }
  event: { subscribe(): AsyncIterable<Ev> }
  session: {
    get(i: { sessionID: string }): Promise<any>
    prompt(i: { sessionID: string; text: string; delivery?: "steer" | "queue" }): Promise<any>
    synthetic(i: { sessionID: string; text: string; description?: string; delivery?: "steer" | "queue"; resume?: boolean }): Promise<any>
    hook(name: "context", cb: (s: { sessionID: string; system: { type: "text"; text: string }[] }) => void): Promise<unknown>
  }
  tool: {
    transform(cb: (d: { add(t: any): void }) => void): Promise<unknown>
    hook(name: "execute.before", cb: (i: { tool: string; sessionID: string }) => void): Promise<unknown>
  }
  command: { transform(cb: (d: { add(c: any): void }) => void): Promise<unknown> }
}

type Goal = {
  text: string
  status: "active" | "paused"
  waitUntil?: number
  // consecutive nudged turns that ended without any tool call
  strikes: number
  nudged: boolean
  toolsSinceNudge: number
  aborted: boolean
}

const DEFAULT_MAX_STRIKES = 5
const DEFAULT_MAX_WAIT_MIN = 30
const SETTLE_MS = 500

export default {
  id: "goal",
  async setup(ctx: Ctx) {
    const maxStrikes = Number(ctx.options.maxStrikes ?? DEFAULT_MAX_STRIKES)
    const maxWaitMin = Number(ctx.options.maxWaitMinutes ?? DEFAULT_MAX_WAIT_MIN)
    const debugFile = process.env.GOAL_DEBUG

    const goals = new Map<string, Goal>()
    const parents = new Map<string, string | null>()
    const busy = new Set<string>()
    const shells = new Map<string, string>() // running shellID -> sessionID
    const shellOwner = new Map<string, string>() // shellID -> sessionID (from tool progress)
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const settle = new Map<string, ReturnType<typeof setTimeout>>()

    const log = (...args: unknown[]) => {
      if (debugFile) appendFileSync(debugFile, JSON.stringify(args) + "\n")
    }

    const rootOf = (id: string) => {
      for (let p = parents.get(id); p; p = parents.get(id)) id = p
      return id
    }
    // sessions with parent info are fetched lazily; unknown ones count as roots until known
    const learn = (id: string) => {
      if (parents.has(id)) return
      parents.set(id, null)
      ctx.session
        .get({ sessionID: id })
        .then((r) => parents.set(id, (r?.data ?? r)?.parentID ?? null))
        .catch((e) => log("session.get failed", String(e)))
    }
    const inFamily = (root: string, id: string) => rootOf(id) === root
    const familyBusy = (root: string) => {
      for (const id of busy) if (inFamily(root, id)) return true
      for (const owner of shells.values()) if (inFamily(root, owner)) return true
      return false
    }

    const clearTimer = (id: string) => {
      const t = timers.get(id)
      if (t) clearTimeout(t)
      timers.delete(id)
    }
    const note = (sessionID: string, text: string) =>
      ctx.session.synthetic({ sessionID, text, description: "goal", resume: false }).catch((e) => log("note failed", String(e)))
    const send = (sessionID: string, text: string) =>
      ctx.session.prompt({ sessionID, text, delivery: "queue" }).catch((e) => log("prompt failed", String(e)))

    // Decide whether the root session needs a push, and push it.
    const evaluate = async (id: string) => {
      const g = goals.get(id)
      if (!g || g.status !== "active" || g.aborted) return
      if (familyBusy(id)) return

      let waitOver = false
      if (g.waitUntil) {
        if (g.waitUntil > Date.now()) return
        g.waitUntil = undefined
        waitOver = true
      }

      if (g.nudged && g.toolsSinceNudge === 0) g.strikes++
      else g.strikes = 0
      if (g.strikes >= maxStrikes) {
        g.status = "paused"
        await note(id, `[goal] Paused: ${g.strikes} pushes in a row without progress. The user can /goal resume.`)
        return
      }

      g.nudged = true
      g.toolsSinceNudge = 0
      await send(id, waitOver ? texts.waitEnded(g.text) : texts.nudge(g.text))
    }

    // A turn may be followed immediately by queued work, so let things settle first.
    const scheduleEvaluate = (id: string) => {
      const prev = settle.get(id)
      if (prev) clearTimeout(prev)
      settle.set(
        id,
        setTimeout(() => {
          settle.delete(id)
          void evaluate(id)
        }, SETTLE_MS),
      )
    }

    const armTimer = (id: string) => {
      clearTimer(id)
      const g = goals.get(id)
      if (!g?.waitUntil) return
      timers.set(id, setTimeout(() => scheduleEvaluate(id), Math.max(0, g.waitUntil - Date.now()) + 50))
    }

    const fresh = (text: string): Goal => ({ text, status: "active", strikes: 0, nudged: false, toolsSinceNudge: 0, aborted: false })

    // Shared by the /goal command and the goal tool.
    const apply = (id: string, action: string, text?: string, minutes?: number): string => {
      const g = goals.get(id)
      switch (action) {
        case "set":
          if (!text?.trim()) return "Error: text is required."
          if (g) {
            g.text = text.trim()
            return "Goal updated."
          }
          goals.set(id, fresh(text.trim()))
          return "Goal set."
        case "done":
        case "clear":
          if (!g) return "No goal."
          goals.delete(id)
          clearTimer(id)
          return "Goal finished."
        case "pause":
          if (!g) return "No goal."
          g.status = "paused"
          clearTimer(id)
          return "Goal paused."
        case "resume":
          if (!g) return "No goal."
          Object.assign(g, { status: "active", strikes: 0, nudged: false, waitUntil: undefined })
          return "Goal resumed."
        case "wait": {
          if (!g) return "No goal."
          const min = Math.min(minutes ?? maxWaitMin, maxWaitMin)
          g.waitUntil = Date.now() + min * 60_000
          armTimer(id)
          return `Not pushing for ${min} min.`
        }
        case "status":
          return g ? `Goal (${g.status}): ${g.text}` : "No goal."
        default:
          return `Unknown action: ${action}`
      }
    }

    await ctx.command.transform((d) =>
      d.add({
        name: "goal",
        description: "Set or control the goal: /goal <text> | pause | resume | clear | status",
        execute: async (a: { sessionID: string; prompt: { text: string }; delivery?: "steer" | "queue" }) => {
          const args = a.prompt.text.trim()
          const id = rootOf(a.sessionID)
          if (!args || ["pause", "resume", "clear", "status"].includes(args)) {
            await note(a.sessionID, `[goal] ${apply(id, args || "status")}`)
            return
          }
          apply(id, "set", args)
          const g = goals.get(id)!
          Object.assign(g, { status: "active", strikes: 0, nudged: false, aborted: false, waitUntil: undefined })
          await ctx.session.prompt({ ...a.prompt, sessionID: a.sessionID, text: `Goal: ${args}`, delivery: a.delivery })
        },
      }),
    )

    await ctx.tool.transform((d) =>
      d.add({
        name: "goal",
        options: { codemode: false },
        description: texts.toolDescription,
        input: Schema.Struct({
          action: Schema.Literals(["done", "set", "pause", "resume", "wait"]),
          text: Schema.optional(Schema.String),
          minutes: Schema.optional(Schema.Number),
        }),
        output: Schema.String,
        execute: async (input: { action: string; text?: string; minutes?: number }, tctx: { sessionID: string }) => {
          const id = rootOf(tctx.sessionID)
          if (!goals.has(id)) return "There is no active goal."
          return apply(id, input.action, input.text, input.minutes)
        },
      }),
    )

    await ctx.tool.hook("execute.before", (i) => {
      const g = goals.get(rootOf(i.sessionID))
      if (g && i.tool !== "goal") g.toolsSinceNudge++
    })

    await ctx.session.hook("context", (s) => {
      if (parents.get(s.sessionID)) return
      const g = goals.get(s.sessionID)
      if (g?.status === "active") s.system.push({ type: "text", text: texts.systemLine(g.text) })
    })

    const onEvent = (e: Ev) => {
      const d = e.data ?? {}
      const sid: string | undefined = d.sessionID
      if (sid) learn(sid)
      switch (e.type) {
        case "session.step.started":
          busy.add(sid!)
          break
        case "session.step.ended":
          // "tool-calls" means the loop continues with another step
          if (d.finish === "tool-calls") break
          busy.delete(sid!)
          scheduleEvaluate(rootOf(sid!))
          break
        case "session.idle":
          busy.delete(sid!)
          scheduleEvaluate(rootOf(sid!))
          break
        // a failed or interrupted run is not something a push can fix
        case "session.step.failed":
        case "session.execution.failed":
        case "session.execution.interrupted": {
          busy.delete(sid!)
          const g = goals.get(rootOf(sid!))
          if (g) g.aborted = true
          break
        }
        case "session.inbox.enqueued": {
          // a real user message resets everything that suppresses or counts pushes
          const g = goals.get(rootOf(sid!))
          const text: string = d.item?.payload?.text ?? ""
          if (g && d.item?.type === "user" && !text.startsWith("[goal]")) {
            Object.assign(g, { aborted: false, strikes: 0, nudged: false, waitUntil: undefined })
            clearTimer(rootOf(sid!))
          }
          break
        }
        case "session.tool.progress":
          if (d.metadata?.shellID) shellOwner.set(d.metadata.shellID, sid!)
          break
        case "shell.created": {
          const owner = shellOwner.get(d.info?.id)
          if (owner) shells.set(d.info.id, owner)
          break
        }
        case "shell.exited": {
          const owner = shells.get(d.id)
          shells.delete(d.id)
          shellOwner.delete(d.id)
          if (owner) scheduleEvaluate(rootOf(owner))
          break
        }
        case "session.deleted":
          if (sid) {
            goals.delete(sid)
            parents.delete(sid)
            busy.delete(sid)
            clearTimer(sid)
          }
          break
      }
    }

    void (async () => {
      for await (const e of ctx.event.subscribe()) {
        if (e.location && !e.location.directory.startsWith(ctx.location.project.directory)) continue
        if (debugFile && !/delta|streamed|usage|reasoning|text\./.test(e.type)) log("EV", e.type, JSON.stringify(e.data).slice(0, 200))
        try {
          onEvent(e)
        } catch (err) {
          log("event handler failed", e.type, String(err))
        }
      }
    })()
  },
}
