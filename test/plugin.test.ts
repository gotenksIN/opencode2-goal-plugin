import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import plugin from "../index"

interface RegisteredTool {
  name: string
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>
}

const root = join(import.meta.dir, ".plugin")
afterEach(() => rm(root, { recursive: true, force: true }))

async function setupPlugin(name: string) {
  const tools: RegisteredTool[] = []
  const commands = new Map<string, Record<string, unknown>>()
  const sessionHooks = new Map<string, Function>()
  const toolHooks = new Map<string, Function>()
  const ctx = {
    options: { autoContinue: false, dataFile: join(root, `${name}.json`) },
    tool: {
      transform: async (callback: Function) => callback({ add: (tool: RegisteredTool) => tools.push(tool) }),
      hook: async (hookName: string, callback: Function) => { toolHooks.set(hookName, callback) },
    },
    command: {
      transform: async (callback: Function) => callback({
        update: (commandName: string, update: Function) => {
          const command = { name: commandName, template: "" }
          update(command)
          commands.set(commandName, command)
        },
      }),
    },
    session: {
      hook: async (hookName: string, callback: Function) => { sessionHooks.set(hookName, callback) },
      prompt: async () => ({}),
      interrupt: async () => ({}),
    },
    event: { subscribe: async () => ({ async *[Symbol.asyncIterator]() {} }) },
  }
  const cleanup = await plugin.setup(ctx as never)
  const tool = (toolName: string) => tools.find((item) => item.name === toolName)!
  return { cleanup, commands, sessionHooks, toolHooks, tools, tool }
}

async function recordSuccessfulTool(toolHooks: Map<string, Function>, sessionID: string, id: string) {
  await toolHooks.get("execute.after")?.({ status: "completed", tool: "shell", sessionID, id })
}

describe("plugin registration", () => {
  test("registers one command, exactly four tools, and runtime hooks", async () => {
    const harness = await setupPlugin("registration")
    expect(plugin.id).toBe("opencode.goal")
    expect(harness.tools.map((tool) => tool.name)).toEqual(["get_goal", "create_goal", "update_goal", "clear_goal"])
    expect(harness.commands.get("goal")?.template).toContain("$ARGUMENTS")
    expect([...harness.sessionHooks.keys()]).toEqual(["context"])
    expect([...harness.toolHooks.keys()]).toEqual(["execute.after"])
    expect(typeof harness.cleanup).toBe("function")
    await harness.cleanup?.()
  })

})

describe("completion evidence candidates", () => {
  test("records only successful non-goal tool call IDs", async () => {
    const harness = await setupPlugin("recording")
    const after = harness.toolHooks.get("execute.after")!
    await after({ status: "error", tool: "shell", sessionID: "s", id: "failed-id" })
    await after({ status: "completed", tool: "get_goal", sessionID: "s", id: "goal-id" })
    await recordSuccessfulTool(harness.toolHooks, "s", "real-id")

    const result = await harness.tool("get_goal").execute({}, { sessionID: "s" })
    expect(JSON.parse(result.content).evidenceCandidates).toEqual(["real-id"])
    await harness.cleanup?.()
  })

  test("exposes a recorded ID in get_goal and active goal context", async () => {
    const harness = await setupPlugin("exposure")
    await harness.tool("create_goal").execute({ objective: "Verify evidence" }, { sessionID: "s" })
    await recordSuccessfulTool(harness.toolHooks, "s", "verification-id")

    const result = await harness.tool("get_goal").execute({}, { sessionID: "s" })
    expect(result.content).toContain("verification-id")
    expect(result.content).toContain("copy one exact evidence candidate ID")

    const event = { sessionID: "s", messages: [], system: [] as Array<{ text: string }> }
    await harness.sessionHooks.get("context")?.(event)
    expect(event.system[0]?.text).toContain("verification-id")
    expect(event.system[0]?.text).toContain("copy one exact ID")
    await harness.cleanup?.()
  })

  test("completes a goal with a real recorded ID", async () => {
    const harness = await setupPlugin("complete")
    await harness.tool("create_goal").execute({ objective: "Complete safely" }, { sessionID: "s" })
    await recordSuccessfulTool(harness.toolHooks, "s", "test-call-id")

    const result = await harness.tool("update_goal").execute({
      action: "complete",
      evidence: { source: "test", summary: "Bun tests passed", success: true, toolCallID: "test-call-id" },
    }, { sessionID: "s" })
    expect(JSON.parse(result.content).status).toBe("complete")
    await harness.cleanup?.()
  })

  test("rejects a fabricated evidence ID", async () => {
    const harness = await setupPlugin("fake")
    await harness.tool("create_goal").execute({ objective: "Reject labels" }, { sessionID: "s" })
    await recordSuccessfulTool(harness.toolHooks, "s", "real-id")

    await expect(harness.tool("update_goal").execute({
      action: "complete",
      evidence: { source: "test", summary: "Claimed success", success: true, toolCallID: "bun-publish-dry-run" },
    }, { sessionID: "s" })).rejects.toThrow("exact evidence candidate ID")
    await harness.cleanup?.()
  })

  test("does not reuse an evidence ID across sessions", async () => {
    const harness = await setupPlugin("sessions")
    await harness.tool("create_goal").execute({ objective: "First session" }, { sessionID: "a" })
    await harness.tool("create_goal").execute({ objective: "Second session" }, { sessionID: "b" })
    await recordSuccessfulTool(harness.toolHooks, "a", "session-a-id")

    await expect(harness.tool("update_goal").execute({
      action: "complete",
      evidence: { source: "verification", summary: "Wrong session", success: true, toolCallID: "session-a-id" },
    }, { sessionID: "b" })).rejects.toThrow("for this session")
    await harness.cleanup?.()
  })
})
