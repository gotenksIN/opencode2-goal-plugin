import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import plugin from "../index"
import type { CreateGoalInput, UpdateGoalInput } from "../src/types"

interface EmptyToolInput {}

type ToolInput = EmptyToolInput | CreateGoalInput | UpdateGoalInput

interface ToolContext {
  sessionID: string
}

interface RegisteredTool {
  name: string
  execute: (input: ToolInput, context: ToolContext) => Promise<{ content: string }>
}

interface HarnessCommandInvocation {
  sessionID: string
  prompt: {
    text: string
    files?: Array<{ uri: string; mention?: { start: number; end: number; text: string } }>
  }
  delivery: "steer" | "queue"
}

interface HarnessCommand {
  name: string
  description?: string
  execute: (input: HarnessCommandInvocation) => Promise<void>
}

interface HarnessSession {
  id: string
  parentID?: string
}

type MetadataScalar = string | number | boolean

interface HarnessPromptInput {
  text: string
  sessionID: string
  delivery?: "steer" | "queue"
  metadata?: Record<string, MetadataScalar>
  files?: Array<{ uri: string; mention?: { start: number; end: number; text: string } }>
}

interface HarnessContextEvent {
  sessionID: string
  messages: Array<object>
  system: Array<{ type: string; text: string }>
}

type HarnessToolHookEvent = {
  tool: string
  sessionID: string
  id: string
} & (
  | { status: "completed"; result: { output?: unknown } }
  | { status: "error"; error: { message: string } }
)

type ContextHook = (event: HarnessContextEvent) => Promise<void> | void

type ToolHook = (event: HarnessToolHookEvent) => Promise<void> | void

const root = join(import.meta.dir, ".plugin")

afterEach(() => rm(root, { recursive: true, force: true }))

type HarnessEvent =
  | { type: "session.execution.succeeded"; data: { sessionID: string } }
  | { type: "session.execution.failed"; data: { sessionID: string; error: { type: string; message: string } } }
  | { type: "session.execution.interrupted"; data: { sessionID: string; reason: "user" | "shutdown" | "superseded" | "inactivity" } }

interface HarnessOptions {
  childSessions?: Set<string>
  autoContinue?: boolean
  continuationIntervalMs?: number
  maxContinuations?: number
  maxTokens?: number
  noProgressTurns?: number
  promptGate?: Promise<void>
  events?: AsyncIterable<HarnessEvent>
}

async function setupPlugin(name: string, options: HarnessOptions = {}) {
  const tools: RegisteredTool[] = []
  const commands = new Map<string, HarnessCommand>()
  const sessionHooks = new Map<string, ContextHook>()
  const toolHooks = new Map<string, ToolHook>()
  const interrupts: string[] = []
  const prompts: HarnessPromptInput[] = []

  const ctx = {
    options: {
      autoContinue: options.autoContinue ?? false,
      continuationIntervalMs: options.continuationIntervalMs,
      maxContinuations: options.maxContinuations,
      maxTokens: options.maxTokens,
      noProgressTurns: options.noProgressTurns,
      dataFile: join(root, `${name}.json`),
    },
    tool: {
      transform: async (callback: Function) => callback({ add: (tool: RegisteredTool) => tools.push(tool) }),
      hook: async (hookName: string, callback: ToolHook) => { toolHooks.set(hookName, callback) },
    },
    command: {
      transform: async (callback: Function) => callback({
        add: (command: HarnessCommand) => {
          commands.set(command.name, command)
        },
      }),
    },
    session: {
      hook: async (hookName: string, callback: ContextHook) => { sessionHooks.set(hookName, callback) },
      prompt: async (input: HarnessPromptInput) => {
        prompts.push(input)
        await options.promptGate

        return {}
      },
      get: async (input: { sessionID: string }) => {
        const session: HarnessSession = { id: input.sessionID }

        if (options.childSessions?.has(input.sessionID)) session.parentID = "ses_parent"

        return session
      },
      interrupt: async (input: { sessionID: string }) => { interrupts.push(input.sessionID) },
    },
    event: {
      subscribe: () =>
        options.events ?? {
          async *[Symbol.asyncIterator]() {},
        },
    },
  }

  // SAFETY: the harness stubs the option, tool, command, session, and event domains that setup consumes.
  const cleanup = await plugin.setup(ctx as never)
  const tool = (toolName: string) => tools.find((item) => item.name === toolName)!

  return { cleanup, commands, sessionHooks, toolHooks, tools, tool, interrupts, prompts }
}

async function recordSuccessfulTool(toolHooks: Map<string, ToolHook>, sessionID: string, id: string) {
  await toolHooks.get("execute.after")?.({
    status: "completed",
    tool: "shell",
    sessionID,
    id,
    result: { output: { output: "", truncated: false, status: "completed", exit: 0 } },
  })
}

describe("goal command", () => {
  test("executes goal command by dispatching prompt to session", async () => {
    const harness = await setupPlugin("command-exec")
    const goalCmd = harness.commands.get("goal")
    expect(goalCmd).toBeDefined()
    await goalCmd?.execute({
      sessionID: "s-123",
      prompt: {
        text: "create Finish the feature @plan.md",
        files: [{ uri: "file:///plan.md", mention: { start: 26, end: 34, text: "@plan.md" } }],
      },
      delivery: "queue",
    })
    expect(harness.prompts).toHaveLength(1)
    expect(harness.prompts[0]?.sessionID).toBe("s-123")
    expect(harness.prompts[0]?.text).toContain("Arguments: create Finish the feature @plan.md")
    expect(harness.prompts[0]?.delivery).toBe("queue")
    expect(harness.prompts[0]?.files).toEqual([{ uri: "file:///plan.md" }])
    await harness.cleanup?.()
  })
})

describe("completion evidence candidates", () => {
  test("records only successful non-goal tool call IDs", async () => {
    const harness = await setupPlugin("recording")
    const after = harness.toolHooks.get("execute.after")!
    await after({
      status: "completed",
      tool: "shell",
      sessionID: "s",
      id: "pre-goal-id",
      result: { output: { output: "", truncated: false, status: "completed", exit: 0 } },
    })
    await after({ status: "error", tool: "shell", sessionID: "s", id: "failed-id", error: { message: "failed" } })
    await after({ status: "completed", tool: "get_goal", sessionID: "s", id: "goal-id", result: {} })
    await harness.tool("create_goal").execute({ objective: "Record evidence" }, { sessionID: "s" })
    await recordSuccessfulTool(harness.toolHooks, "s", "real-id")

    const result = await harness.tool("get_goal").execute({}, { sessionID: "s" })
    expect(JSON.parse(result.content).evidenceCandidates).toEqual(["real-id"])
    await harness.cleanup?.()
  })

  test("rejects completed tool events whose structured outcome failed", async () => {
    const harness = await setupPlugin("failed-outcomes")
    const after = harness.toolHooks.get("execute.after")!
    await harness.tool("create_goal").execute({ objective: "Verify outcomes" }, { sessionID: "s" })

    for (const [id, output] of [
      ["nonzero", { output: "failed", truncated: false, status: "completed", exit: 1 }],
      ["timeout", { output: "timed out", truncated: false, status: "completed", exit: 1, timeout: true }],
      ["background", { output: "running", truncated: false, status: "running", shellID: "sh_1" }],
    ] satisfies Array<[string, object]>) {
      await after({ status: "completed", tool: "shell", sessionID: "s", id, result: { output } })
    }

    await after({ status: "completed", tool: "patch", sessionID: "s", id: "shared", result: {} })
    await after({
      status: "completed",
      tool: "execute",
      sessionID: "s",
      id: "shared",
      result: {
        output: {
          output: "Tool call failed",
          toolCalls: [{ tool: "patch", status: "completed" }],
          error: true,
          files: [],
        },
      },
    })
    await after({
      status: "completed",
      tool: "execute",
      sessionID: "s",
      id: "child-error",
      result: {
        output: {
          output: "Caught child failure",
          toolCalls: [{ tool: "shell", status: "error" }],
          files: [],
        },
      },
    })

    const result = await harness.tool("get_goal").execute({}, { sessionID: "s" })
    expect(JSON.parse(result.content).evidenceCandidates).toEqual([])
    await harness.cleanup?.()
  })

  test("exposes a recorded ID in get_goal and active goal context", async () => {
    const harness = await setupPlugin("exposure")
    await harness.tool("create_goal").execute({ objective: "Verify evidence" }, { sessionID: "s" })
    await recordSuccessfulTool(harness.toolHooks, "s", "verification-id")

    const result = await harness.tool("get_goal").execute({}, { sessionID: "s" })
    expect(result.content).toContain("verification-id")
    expect(result.content).toContain("copy one exact evidence candidate ID")

    const event: HarnessContextEvent = { sessionID: "s", messages: [], system: [] }
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

describe("subagent session interrupts", () => {
  test("clear_goal does not interrupt a subagent session", async () => {
    const harness = await setupPlugin("clear-child", { childSessions: new Set(["child"]) })
    await harness.tool("create_goal").execute({ objective: "Subagent task" }, { sessionID: "child" })
    const result = await harness.tool("clear_goal").execute({}, { sessionID: "child" })
    expect(result.content).toBe("Goal cleared.")
    expect(harness.interrupts).toEqual([])
    await harness.cleanup?.()
  })

  test("update_goal pause and blocked do not interrupt a subagent session", async () => {
    const harness = await setupPlugin("pause-child", { childSessions: new Set(["child-a", "child-b"]) })
    await harness.tool("create_goal").execute({ objective: "Pause me" }, { sessionID: "child-a" })
    await harness.tool("update_goal").execute({ action: "pause" }, { sessionID: "child-a" })

    await harness.tool("create_goal").execute({ objective: "Block me" }, { sessionID: "child-b" })
    await harness.tool("update_goal").execute({ action: "blocked", blocker: "Waiting" }, { sessionID: "child-b" })

    expect(harness.interrupts).toEqual([])
    await harness.cleanup?.()
  })

  test("clear_goal still interrupts a top-level session", async () => {
    const harness = await setupPlugin("clear-top")
    await harness.tool("create_goal").execute({ objective: "Top level" }, { sessionID: "top" })
    await harness.tool("clear_goal").execute({}, { sessionID: "top" })
    expect(harness.interrupts).toEqual(["top"])
    await harness.cleanup?.()
  })
})

describe("auto continuation", () => {
  test("sends the configured maximum number of continuation prompts", async () => {
    async function* eventGenerator(): AsyncGenerator<HarnessEvent> {
      await new Promise((resolve) => setTimeout(resolve, 10))
      yield { type: "session.execution.succeeded", data: { sessionID: "s-limited" } }
      await new Promise((resolve) => setTimeout(resolve, 30))
      yield { type: "session.execution.succeeded", data: { sessionID: "s-limited" } }
    }

    const harness = await setupPlugin("auto-limit", {
      autoContinue: true,
      continuationIntervalMs: 10,
      maxContinuations: 1,
      events: eventGenerator(),
    })

    await harness.tool("create_goal").execute({ objective: "One continuation" }, { sessionID: "s-limited" })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(harness.prompts.filter((prompt) => prompt.sessionID === "s-limited")).toHaveLength(1)
    const result = await harness.tool("get_goal").execute({}, { sessionID: "s-limited" })
    expect(JSON.parse(result.content).goal.status).toBe("budgetLimited")
    await harness.cleanup?.()
  })

  test("accounts progress when the continued turn becomes idle", async () => {
    async function* eventGenerator(): AsyncGenerator<HarnessEvent> {
      await new Promise((resolve) => setTimeout(resolve, 10))
      yield { type: "session.execution.succeeded", data: { sessionID: "s-progress" } }
      await new Promise((resolve) => setTimeout(resolve, 60))
      yield { type: "session.execution.succeeded", data: { sessionID: "s-progress" } }
    }

    const harness = await setupPlugin("auto-progress", {
      autoContinue: true,
      continuationIntervalMs: 20,
      noProgressTurns: 1,
      events: eventGenerator(),
    })

    await harness.tool("create_goal").execute({ objective: "Make progress" }, { sessionID: "s-progress" })
    await new Promise((resolve) => setTimeout(resolve, 40))
    await harness.toolHooks.get("execute.after")?.({
      status: "completed",
      tool: "patch",
      sessionID: "s-progress",
      id: "patch-id",
      result: {},
    })
    await new Promise((resolve) => setTimeout(resolve, 25))

    const result = await harness.tool("get_goal").execute({}, { sessionID: "s-progress" })
    expect(JSON.parse(result.content).goal.status).toBe("active")
    expect(JSON.parse(result.content).goal.noProgressCount).toBe(0)
    await harness.cleanup?.()
  })

  test("sends continuation prompt after successful execution", async () => {
    async function* eventGenerator(): AsyncGenerator<HarnessEvent> {
      await new Promise((resolve) => setTimeout(resolve, 10))
      yield { type: "session.execution.succeeded", data: { sessionID: "s-auto" } }
    }

    const harness = await setupPlugin("auto-status", {
      autoContinue: true,
      continuationIntervalMs: 10,
      events: eventGenerator(),
    })

    await harness.tool("create_goal").execute({ objective: "Auto task" }, { sessionID: "s-auto" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.prompts.some((p) => p.sessionID === "s-auto" && p.text.includes("Continue the persisted goal"))).toBe(true)
    await harness.cleanup?.()
  })

  test("pauses after failed execution and cancels a scheduled continuation", async () => {
    async function* eventGenerator(): AsyncGenerator<HarnessEvent> {
      await new Promise((resolve) => setTimeout(resolve, 10))
      yield { type: "session.execution.succeeded", data: { sessionID: "s-failed" } }
      await new Promise((resolve) => setTimeout(resolve, 10))
      yield {
        type: "session.execution.failed",
        data: { sessionID: "s-failed", error: { type: "ProviderError", message: "Provider stopped" } },
      }
    }

    const harness = await setupPlugin("auto-failed", {
      autoContinue: true,
      continuationIntervalMs: 100,
      events: eventGenerator(),
    })

    await harness.tool("create_goal").execute({ objective: "Pause on failure" }, { sessionID: "s-failed" })
    await new Promise((resolve) => setTimeout(resolve, 130))
    const result = await harness.tool("get_goal").execute({}, { sessionID: "s-failed" })
    expect(JSON.parse(result.content).goal.status).toBe("paused")
    expect(JSON.parse(result.content).goal.history.at(-1)).toMatchObject({
      action: "execution-failed",
      detail: "Provider stopped",
    })
    expect(harness.prompts).toEqual([])
    await harness.cleanup?.()
  })

  test("pauses after interrupted execution without auto-continuation enabled", async () => {
    async function* eventGenerator(): AsyncGenerator<HarnessEvent> {
      await new Promise((resolve) => setTimeout(resolve, 10))
      yield {
        type: "session.execution.interrupted",
        data: { sessionID: "s-interrupted", reason: "user" },
      }
    }

    const harness = await setupPlugin("auto-interrupted", { events: eventGenerator() })
    await harness.tool("create_goal").execute({ objective: "Pause on interrupt" }, { sessionID: "s-interrupted" })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const result = await harness.tool("get_goal").execute({}, { sessionID: "s-interrupted" })
    expect(JSON.parse(result.content).goal.status).toBe("paused")
    expect(JSON.parse(result.content).goal.history.at(-1)).toMatchObject({
      action: "execution-interrupted",
      detail: "user",
    })
    await harness.cleanup?.()
  })

  test("cancels scheduled continuation during cleanup", async () => {
    async function* eventGenerator(): AsyncGenerator<HarnessEvent> {
      await new Promise((resolve) => setTimeout(resolve, 10))
      yield { type: "session.execution.succeeded", data: { sessionID: "s-cleanup" } }
    }

    const harness = await setupPlugin("auto-cleanup", {
      autoContinue: true,
      continuationIntervalMs: 100,
      events: eventGenerator(),
    })

    await harness.tool("create_goal").execute({ objective: "Do not continue" }, { sessionID: "s-cleanup" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await harness.cleanup?.()
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(harness.prompts).toEqual([])
  })

  test("waits for an in-flight continuation during cleanup", async () => {
    let releasePrompt: () => void = () => {}

    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve })

    async function* eventGenerator(): AsyncGenerator<HarnessEvent> {
      await new Promise((resolve) => setTimeout(resolve, 10))
      yield { type: "session.execution.succeeded", data: { sessionID: "s-in-flight" } }
    }

    const harness = await setupPlugin("auto-in-flight", {
      autoContinue: true,
      continuationIntervalMs: 0,
      promptGate,
      events: eventGenerator(),
    })

    await harness.tool("create_goal").execute({ objective: "Finish prompt" }, { sessionID: "s-in-flight" })
    await new Promise((resolve) => setTimeout(resolve, 20))

    let cleaned = false
    const cleanup = Promise.resolve(harness.cleanup?.()).then(() => { cleaned = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(cleaned).toBe(false)
    releasePrompt()
    await cleanup
    expect(cleaned).toBe(true)
  })
})

describe("goal context", () => {
  test("reports a limit reached while accounting for the current context", async () => {
    const harness = await setupPlugin("context-limit", { maxTokens: 0 })
    await harness.tool("create_goal").execute({ objective: "Bound token use" }, { sessionID: "s" })
    const event: HarnessContextEvent = { sessionID: "s", messages: [], system: [] }
    await harness.sessionHooks.get("context")?.(event)

    expect(event.system[0]?.text).toContain("Status: usageLimited")
    expect(event.system[0]?.text).toContain("Do not silently continue")
    await harness.cleanup?.()
  })
})
