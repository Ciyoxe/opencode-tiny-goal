import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

export const GoalPlugin: Plugin = async () => {
  return {
    tool: {
      hello: tool({
        description: "Say hello",
        args: { name: tool.schema.string() },
        async execute({ name }) {
          return `Hello ${name}`
        },
      }),
    },
  }
}
