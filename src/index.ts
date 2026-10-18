import { appendFileSync } from "node:fs"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as texts from "./texts"

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

type Sender = { agent?: string; model?: { providerID: string; modelID: string } }

const DEFAULT_WAIT_MIN = 30

export const GoalPlugin: Plugin = async ({ client }, options) => {
  const maxStrikes = Number(options?.maxStrikes ?? 5)
  const maxWaitMin = Number(options?.maxWaitMinutes ?? DEFAULT_WAIT_MIN)
  const debugFile = process.env.GOAL_DEBUG

  const goals = new Map<string, Goal>()
  const parents = new Map<string, string>()
  const status = new Map<string, string>()
  const senders = new Map<string, Sender>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const log = (...args: unknown[]) => {
    if (debugFile) appendFileSync(debugFile, JSON.stringify(args) + "\n")
  }
  const toast = (message: string, variant: "info" | "success" | "warning" = "info") =>
    client.tui.showToast({ body: { message, variant } }).catch(() => {})

  const rootOf = (id: string) => {
    while (parents.has(id)) id = parents.get(id)!
    return id
  }
  const hasBusyDescendant = (root: string) => {
    for (const [id, st] of status) {
      if (st === "idle" || id === root || rootOf(id) !== root) continue
      return true
    }
    return false
  }

  const clearTimer = (id: string) => {
    const t = timers.get(id)
    if (t) clearTimeout(t)
    timers.delete(id)
  }

  const send = async (id: string, text: string) => {
    const s = senders.get(id)
    await client.session
      .promptAsync({
        path: { id },
        body: { agent: s?.agent, model: s?.model, parts: [{ type: "text", text, synthetic: true }] },
      })
      .catch((e) => log("promptAsync failed", String(e)))
  }

  // Decide whether the root session needs a push, and push it.
  const evaluate = async (id: string) => {
    const g = goals.get(id)
    if (!g || g.status !== "active") return
    if (status.get(id) && status.get(id) !== "idle") return
    if (hasBusyDescendant(id)) return
    if (g.aborted) return

    const now = Date.now()
    let waitEnded = false
    if (g.waitUntil) {
      if (g.waitUntil > now) return
      g.waitUntil = undefined
      waitEnded = true
    }

    if (g.nudged && g.toolsSinceNudge === 0) g.strikes++
    else g.strikes = 0
    if (g.strikes >= maxStrikes) {
      g.status = "paused"
      toast(`Goal paused: ${g.strikes} pushes in a row without progress. /goal resume to continue.`, "warning")
      return
    }

    g.nudged = true
    g.toolsSinceNudge = 0
    await send(id, waitEnded ? texts.waitEnded(g.text) : texts.nudge(g.text))
  }

  const armTimer = (id: string) => {
    clearTimer(id)
    const g = goals.get(id)
    if (!g?.waitUntil) return
    timers.set(
      id,
      setTimeout(() => void evaluate(id), Math.max(0, g.waitUntil - Date.now()) + 50),
    )
  }

  const fresh = (text: string): Goal => ({
    text,
    status: "active",
    strikes: 0,
    nudged: false,
    toolsSinceNudge: 0,
    aborted: false,
  })

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
        g.status = "active"
        g.strikes = 0
        g.nudged = false
        g.waitUntil = undefined
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

  return {
    config: async (config) => {
      config.command ??= {}
      config.command.goal = {
        description: "Set or control the goal: /goal <text> | pause | resume | clear | status",
        template: "$ARGUMENTS",
      }
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "goal") return
      const args = input.arguments.trim()
      const [word, ...rest] = args.split(/\s+/)
      const control = ["pause", "resume", "clear", "status"].includes(word ?? "") && rest.length === 0
      const part = output.parts.find((p) => p.type === "text")
      if (control) {
        const result = apply(input.sessionID, word!)
        toast(result)
        if (part && part.type === "text") part.text = `[goal] ${result} No action needed.`
      } else if (args) {
        apply(input.sessionID, "set", args)
        const g = goals.get(input.sessionID)!
        g.strikes = 0
        if (part && part.type === "text") part.text = `Goal: ${args}`
      } else if (part && part.type === "text") {
        part.text = `[goal] ${apply(input.sessionID, "status")} No action needed.`
      }
    },

    tool: {
      goal: tool({
        description: texts.toolDescription,
        args: {
          action: tool.schema.enum(["done", "set", "pause", "resume", "wait"]),
          text: tool.schema.string().optional().describe("New goal text (for set)"),
          minutes: tool.schema.number().optional().describe(`Minutes to wait (for wait, max ${maxWaitMin})`),
        },
        async execute(args, ctx) {
          const id = rootOf(ctx.sessionID)
          if (!goals.has(id)) return "There is no active goal."
          const result = apply(id, args.action, args.text, args.minutes)
          if (args.action === "done") toast("Goal finished by the agent.", "success")
          return result
        },
      }),
    },

    "experimental.chat.system.transform": async (input, output) => {
      const g = input.sessionID ? goals.get(input.sessionID) : undefined
      if (g?.status === "active") output.system.push(texts.systemLine(g.text))
    },

    "chat.message": async (input, output) => {
      senders.set(input.sessionID, { agent: input.agent, model: input.model })
      const first = output.parts.find((p) => p.type === "text")
      const ours = first?.type === "text" && first.text.startsWith("[goal]")
      const g = goals.get(input.sessionID)
      if (!g || ours) return
      // a real user message: reset everything that suppresses or counts pushes
      g.aborted = false
      g.waitUntil = undefined
      g.strikes = 0
      g.nudged = false
      clearTimer(input.sessionID)
    },

    "tool.execute.after": async (input) => {
      const g = goals.get(rootOf(input.sessionID))
      if (g && input.tool !== "goal") g.toolsSinceNudge++
    },

    event: async ({ event }) => {
      log(event.type, JSON.stringify(event.properties).slice(0, 300))
      switch (event.type) {
        case "session.created":
        case "session.updated": {
          const info = event.properties.info
          if (info.parentID) parents.set(info.id, info.parentID)
          break
        }
        case "session.deleted":
          parents.delete(event.properties.info.id)
          status.delete(event.properties.info.id)
          goals.delete(event.properties.info.id)
          clearTimer(event.properties.info.id)
          break
        case "session.status": {
          const { sessionID, status: st } = event.properties
          status.set(sessionID, st.type)
          break
        }
        case "session.error": {
          const id = event.properties.sessionID
          const g = id ? goals.get(id) : undefined
          if (g && event.properties.error?.name === "MessageAbortedError") g.aborted = true
          break
        }
        case "session.idle": {
          const id = event.properties.sessionID
          status.set(id, "idle")
          await evaluate(rootOf(id))
          break
        }
      }
    },
  }
}
