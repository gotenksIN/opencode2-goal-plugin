import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode-ai/plugin"
import { GoalController, defaultLimits } from "./controller"
import { GoalStore } from "./store"
import type { Goal, GoalOptions } from "./types"

const goalToolNames = new Set(["get_goal", "create_goal", "update_goal", "clear_goal"])
const maxEvidenceCandidatesPerSession = 20
const maxEvidenceCandidateSessions = 100

function dataPath(options: GoalOptions): string {
  if (options.dataFile) {
    return options.dataFile.startsWith("~/")
      ? join(homedir(), options.dataFile.slice(2))
      : options.dataFile
  }
  const root = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(root, "opencode-goal-plugin", "goals.json")
}

function format(goal: Goal | undefined): string {
  return goal ? JSON.stringify(goal, null, 2) : "No goal exists for this session."
}

function formatGoalStatus(goal: Goal | undefined, evidenceCandidates: string[]): string {
  return JSON.stringify({
    goal: goal ?? null,
    evidenceCandidates,
    evidenceInstruction: evidenceCandidates.length
      ? "To complete the goal, copy one exact evidence candidate ID into evidence.toolCallID. Do not invent an ID."
      : "Run a successful non-goal verification tool, then call get_goal again to get its exact evidence candidate ID.",
  }, null, 2)
}

function estimateTokens(value: unknown): number {
  try { return Math.ceil(JSON.stringify(value).length / 4) } catch { return 0 }
}

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function positiveInteger(value: unknown, fallback: number): number {
  return Math.max(1, Math.floor(finiteNonNegative(value, fallback)))
}

export default Plugin.define({
  id: "opencode.goal",
  setup: async (ctx) => {
    const options = ctx.options as GoalOptions
    const limits = {
      maxContinuations: positiveInteger(options.maxContinuations, defaultLimits.maxContinuations),
      maxTokens: finiteNonNegative(options.maxTokens, defaultLimits.maxTokens),
      maxDurationMs: finiteNonNegative(options.maxDurationMs, defaultLimits.maxDurationMs),
      noProgressTurns: positiveInteger(options.noProgressTurns, defaultLimits.noProgressTurns),
    }
    const controller = new GoalController(new GoalStore(dataPath(options)), limits)
    const inFlight = new Set<string>()
    const scheduled = new Set<string>()
    const evidenceCandidates = new Map<string, string[]>()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    let stopped = false
    let eventIterator: AsyncIterator<unknown> | undefined

    const isSubagentSession = async (sessionID: string): Promise<boolean> => {
      try {
        const session = await ctx.session.get({ sessionID })
        return typeof session.parentID === "string" && session.parentID.length > 0
      } catch {
        return false
      }
    }

    const interruptSession = async (sessionID: string): Promise<void> => {
      if (await isSubagentSession(sessionID)) return
      await ctx.session.interrupt({ sessionID }).catch(() => undefined)
    }

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "get_goal",
        description: "Get the persisted goal and recent valid evidence candidate IDs for this session.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async (_input, toolCtx) => ({
          content: formatGoalStatus(await controller.get(toolCtx.sessionID), evidenceCandidates.get(toolCtx.sessionID) ?? []),
        }),
      })
      tools.add({
        name: "create_goal",
        description: "Create one persisted goal for this session.",
        input: {
          type: "object",
          properties: { objective: { type: "string", minLength: 1 } },
          required: ["objective"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, toolCtx) => {
          const value = input as { objective: string }
          return { content: format(await controller.create(toolCtx.sessionID, value.objective)) }
        },
      })
      tools.add({
        name: "update_goal",
        description: "Pause, resume, block, or complete the session goal. Completion requires successful structured evidence.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["pause", "resume", "blocked", "complete"] },
            blocker: { type: "string" },
            evidence: {
              type: "object",
              properties: {
                source: { type: "string", enum: ["tool", "test", "verification"] },
                summary: { type: "string", minLength: 3 },
                success: { type: "boolean" },
                toolCallID: { type: "string" },
              },
              required: ["source", "summary", "success"],
              additionalProperties: false,
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, toolCtx) => {
          const value = input as {
            action: "pause" | "resume" | "blocked" | "complete"
            blocker?: string
            evidence?: unknown
          }
          if (value.action === "complete") {
            const evidence = value.evidence as { toolCallID?: unknown } | undefined
            if (typeof evidence?.toolCallID !== "string" || !evidenceCandidates.get(toolCtx.sessionID)?.includes(evidence.toolCallID)) {
              throw new Error("Completion evidence must reference an exact evidence candidate ID from get_goal for this session")
            }
          }
          const updated = await controller.update(toolCtx.sessionID, value.action, value)
          if (value.action === "complete") evidenceCandidates.delete(toolCtx.sessionID)
          if (value.action === "pause" || value.action === "blocked") {
            await interruptSession(toolCtx.sessionID)
          }
          return { content: format(updated) }
        },
      })
      tools.add({
        name: "clear_goal",
        description: "Remove the persisted goal for this session.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async (_input, toolCtx) => {
          await controller.clear(toolCtx.sessionID)
          evidenceCandidates.delete(toolCtx.sessionID)
          await interruptSession(toolCtx.sessionID)
          return { content: "Goal cleared." }
        },
      })
    })

    await ctx.command.transform((commands) => {
      commands.update("goal", (command) => {
        command.description = "Create, inspect, pause, resume, block, complete, or clear a session goal"
        command.template = [
          "Route this goal command through the matching goal controller tools.",
          "Arguments: $ARGUMENTS",
          "With no arguments or with 'status', call get_goal.",
          "A plain objective or 'create OBJECTIVE' calls create_goal.",
          "pause, resume, and blocked BLOCKER call update_goal.",
          "For complete, call get_goal if needed, then copy an exact evidence candidate ID into structured evidence for update_goal.",
          "clear calls clear_goal.",
          "For complete, require a JSON evidence object with source, summary, and success=true.",
          "Never infer completion from prose and never claim a state change without the tool result.",
        ].join("\n")
      })
    })

    await ctx.session.hook("context", async (event) => {
      const goal = await controller.get(event.sessionID)
      if (!goal) return
      await controller.account(event.sessionID, estimateTokens(event.messages))
      const state = goal.status === "active"
        ? "Continue work toward this goal. Use goal tools for every state change. Complete only with successful structured evidence."
        : `Do not silently continue this goal because its state is ${goal.status}.`
      const candidates = evidenceCandidates.get(event.sessionID) ?? []
      const evidenceContext = candidates.length
        ? `\nRecent valid evidence candidate IDs: ${JSON.stringify(candidates)}\nFor completion, copy one exact ID into evidence.toolCallID. Do not invent an ID.`
        : "\nNo evidence candidate is available. Run a successful non-goal verification tool, then call get_goal."
      event.system.push({
        type: "text",
        text: `[Persisted goal]\nObjective: ${goal.objective}\nStatus: ${goal.status}${goal.blocker ? `\nBlocker: ${goal.blocker}` : ""}\n${state}${evidenceContext}`,
        metadata: { plugin: "opencode.goal" },
      })
    })

    await ctx.tool.hook("execute.after", async (event) => {
      if (stopped || event.status !== "completed" || goalToolNames.has(event.tool)) return
      const recent = evidenceCandidates.get(event.sessionID) ?? []
      const next = [...recent.filter((id) => id !== event.id), event.id].slice(-maxEvidenceCandidatesPerSession)
      evidenceCandidates.delete(event.sessionID)
      evidenceCandidates.set(event.sessionID, next)
      while (evidenceCandidates.size > maxEvidenceCandidateSessions) {
        const oldestSession = evidenceCandidates.keys().next().value
        if (oldestSession === undefined) break
        evidenceCandidates.delete(oldestSession)
      }
      const meaningful = new Set(["edit", "write", "patch"])
      await controller.checkpoint(event.sessionID, `Successful ${event.tool} tool call`, event.tool, meaningful.has(event.tool))
    })

    const continueGoal = async (sessionID: string) => {
      if (stopped || inFlight.has(sessionID)) return
      inFlight.add(sessionID)
      try {
        const goal = await controller.get(sessionID)
        if (!goal || goal.status !== "active") return
        const before = goal.checkpoints.length
        await controller.account(sessionID, 0, true, false)
        const checked = await controller.get(sessionID)
        if (!checked || checked.status !== "active") return
        await ctx.session.prompt({
          sessionID,
          text: "Continue the persisted goal from the latest checkpoint. Do not mark it complete without successful structured evidence.",
          metadata: { plugin: "opencode.goal", continuation: checked.continuationCount },
        })
        const after = await controller.get(sessionID)
        if (after && after.checkpoints.length > before) {
          await controller.account(sessionID, 0, false, true)
        }
      } finally {
        inFlight.delete(sessionID)
      }
    }

    if (options.autoContinue !== false) {
      const stream = await ctx.event.subscribe()
      eventIterator = stream[Symbol.asyncIterator]()
      void (async () => {
        try {
          while (!stopped) {
            const item = await eventIterator!.next()
            if (item.done) break
            const event = item.value as { type?: string; data?: { sessionID?: string } }
            if (event.type !== "session.idle" || !event.data?.sessionID) continue
            if (scheduled.has(event.data.sessionID) || inFlight.has(event.data.sessionID)) continue
            scheduled.add(event.data.sessionID)
            const timer = setTimeout(() => {
              timers.delete(timer)
              scheduled.delete(event.data!.sessionID!)
              void continueGoal(event.data!.sessionID!).catch(() => undefined)
            }, Math.max(0, options.continuationIntervalMs ?? 1500))
            timers.add(timer)
          }
        } catch {
          if (!stopped) return
        }
      })()
    }

    return async () => {
      stopped = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      scheduled.clear()
      evidenceCandidates.clear()
      await eventIterator?.return?.()
    }
  },
})
