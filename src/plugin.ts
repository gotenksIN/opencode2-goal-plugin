import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import type { PluginOptions } from "@opencode/plugin"
import { GoalController } from "./controller"
import { GoalStore } from "./store"
import type { CreateGoalInput, Goal, UpdateGoalInput } from "./types"

const goalToolNames = new Set(["get_goal", "create_goal", "update_goal", "clear_goal"])

const maxEvidenceCandidatesPerSession = 20

const maxEvidenceCandidateSessions = 100

function dataPath(options: PluginOptions): string {
  if (options.dataFile) {
    return options.dataFile.startsWith("~/")
      ? join(homedir(), options.dataFile.slice(2))
      : options.dataFile
  }

  const root = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")

  return join(root, "opencode-goal-plugin", "goals.json")
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

function estimateTokens(messages: ReadonlyArray<object>): number {
  try { return Math.ceil(JSON.stringify(messages).length / 4) } catch { return 0 }
}

function configuredLimit(name: string, value: PluginOptions[string], integer = false): number | undefined {
  if (value === undefined) return undefined

  if (!Number.isFinite(value) || value < 0 || (integer && (!Number.isInteger(value) || value === 0))) {
    throw new Error(`${name} must be ${integer ? "a positive integer" : "a finite non-negative number"}`)
  }

  return value
}

function structuredToolOutputSucceeded(tool: "shell" | "execute", output: ReturnType<typeof JSON.parse>): boolean {
  if (output === null || output instanceof Object === false) return false

  if (tool === "shell") {
    return "status" in output
      && output.status === "completed"
      && "exit" in output
      && output.exit === 0
      && (!("timeout" in output) || output.timeout !== true)
  }

  if (("error" in output && output.error === true) || !("toolCalls" in output) || !Array.isArray(output.toolCalls)) {
    return false
  }

  return output.toolCalls.every((call: ReturnType<typeof JSON.parse>) => (
    call !== null
    && call instanceof Object
    && "status" in call
    && call.status === "completed"
  ))
}

export default Plugin.define({
  id: "opencode.goal",
  setup: async (ctx) => {
    const options = ctx.options

    const limits = {
      maxContinuations: configuredLimit("maxContinuations", options.maxContinuations, true),
      maxTokens: configuredLimit("maxTokens", options.maxTokens),
      maxDurationMs: configuredLimit("maxDurationMs", options.maxDurationMs),
      noProgressTurns: configuredLimit("noProgressTurns", options.noProgressTurns, true),
    }

    const controller = new GoalController(new GoalStore(dataPath(options), !options.dataFile), limits)
    const inFlight = new Set<string>()
    const admissionTokens = new Map<string, symbol>()
    const generations = new Map<string, symbol>()
    const rescheduleAfterAdmission = new Set<string>()
    const scheduled = new Map<string, ReturnType<typeof setTimeout>>()
    const pendingContinuations = new Map<string, { before: number, createdAt: string, generation?: symbol }>()
    const evidenceCandidates = new Map<string, string[]>()
    const rejectedEvidenceCandidates = new Map<string, string[]>()
    let stopped = false
    let stopStream: (() => Promise<void>) | undefined

    const ownsSession = async (sessionID: string): Promise<boolean> => {
      try {
        const session = await ctx.session.get({ sessionID })

        return session.projectID === ctx.location.project.id
          && session.location.directory === ctx.location.directory
          && (!("workspaceID" in session.location) || session.location.workspaceID === ctx.location.workspaceID)
      } catch {
        return false
      }
    }

    const isSubagentSession = async (sessionID: string): Promise<boolean> => {
      try {
        const session = await ctx.session.get({ sessionID })

        return session.parentID !== undefined && session.parentID.length > 0
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
          // SAFETY: OpenCode decodes tool input against the create_goal schema, so objective is a non-empty string.
          const value = input as CreateGoalInput

          const created = await controller.create(toolCtx.sessionID, value.objective)
          cancelContinuation(toolCtx.sessionID)

          return { content: JSON.stringify(created, null, 2) }
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
              required: ["source", "summary", "success", "toolCallID"],
              additionalProperties: false,
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, toolCtx) => {
          // SAFETY: OpenCode decodes tool input against the update_goal schema, so action is a known literal and evidence matches the nested schema.
          const value = input as UpdateGoalInput

          if (value.action === "complete") {
            const toolCallID = value.evidence?.toolCallID

            if (toolCallID === undefined || !evidenceCandidates.get(toolCtx.sessionID)?.includes(toolCallID)) {
              throw new Error("Completion evidence must reference an exact evidence candidate ID from get_goal for this session")
            }
          }

          const updated = await controller.update(toolCtx.sessionID, value.action, value)

          if (value.action === "complete") evidenceCandidates.delete(toolCtx.sessionID)

          if (value.action !== "resume") cancelContinuation(toolCtx.sessionID)

          if (value.action === "pause" || value.action === "blocked") {
            await interruptSession(toolCtx.sessionID)
          }

          return { content: JSON.stringify(updated, null, 2) }
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
          cancelContinuation(toolCtx.sessionID)
          await interruptSession(toolCtx.sessionID)

          return { content: "Goal cleared." }
        },
      })
    })

    await ctx.command.transform((commands) => {
      commands.add({
        name: "goal",
        description: "Create, inspect, pause, resume, block, complete, or clear a session goal",
        execute: async ({ sessionID, prompt, delivery }) => {
          const instructions = [
            "Route this goal command through the matching goal controller tools.",
            `Arguments: ${prompt.text}`,
            "With no arguments or with 'status', call get_goal.",
            "A plain objective or 'create OBJECTIVE' calls create_goal.",
            "pause, resume, and blocked BLOCKER call update_goal.",
            "For complete, call get_goal if needed, then copy an exact evidence candidate ID into structured evidence for update_goal.",
            "clear calls clear_goal.",
            "For complete, require a JSON evidence object with source, summary, and success=true.",
            "Never infer completion from prose and never claim a state change without the tool result.",
          ].join("\n")

          await ctx.session.prompt({
            files: prompt.files?.map((file) => ({ uri: file.uri, name: file.name, description: file.description })),
            agents: prompt.agents?.map((agent) => ({ name: agent.name })),
            skills: prompt.skills?.map((skill) => ({ id: skill.id })),
            sessionID,
            text: instructions,
            delivery,
          })
        },
      })
    })

    await ctx.session.hook("context", async (event) => {
      const goal = await controller.get(event.sessionID)

      if (!goal) return
      const accounted = await controller.account(event.sessionID, estimateTokens(event.messages))

      if (!accounted) return

      if (accounted.status === "usageLimited" || accounted.status === "budgetLimited") cancelContinuation(event.sessionID)

      const state = accounted.status === "active"
        ? "Continue work toward this goal. Use goal tools for every state change. Complete only with successful structured evidence."
        : `Do not silently continue this goal because its state is ${accounted.status}.`

      const candidates = evidenceCandidates.get(event.sessionID) ?? []

      const evidenceContext = candidates.length
        ? `\nRecent valid evidence candidate IDs: ${JSON.stringify(candidates)}\nFor completion, copy one exact ID into evidence.toolCallID. Do not invent an ID.`
        : "\nNo evidence candidate is available. Run a successful non-goal verification tool, then call get_goal."

      event.system.push({
        type: "text",
        text: `[Persisted goal]\nObjective: ${accounted.objective}\nStatus: ${accounted.status}${accounted.blocker ? `\nBlocker: ${accounted.blocker}` : ""}\n${state}${evidenceContext}`,
        metadata: { plugin: "opencode.goal" },
      })
    })

    await ctx.tool.hook("execute.after", async (event) => {
      if (stopped || goalToolNames.has(event.tool)) return
      const goal = await controller.get(event.sessionID)

      if (!goal || goal.status !== "active") return
      let succeeded = false

      if (event.status === "completed") {
        succeeded = event.tool !== "shell" && event.tool !== "execute"
          ? true
          : structuredToolOutputSucceeded(event.tool, event.result.output)
      }

      const rejected = rejectedEvidenceCandidates.get(event.sessionID) ?? []

      if (!succeeded) {
        const remaining = (evidenceCandidates.get(event.sessionID) ?? []).filter((id) => id !== event.id)

        if (remaining.length > 0) evidenceCandidates.set(event.sessionID, remaining)
        else evidenceCandidates.delete(event.sessionID)
        rejectedEvidenceCandidates.delete(event.sessionID)
        rejectedEvidenceCandidates.set(
          event.sessionID,
          [...rejected.filter((id) => id !== event.id), event.id].slice(-maxEvidenceCandidatesPerSession),
        )

        while (rejectedEvidenceCandidates.size > maxEvidenceCandidateSessions) {
          const oldestSession = rejectedEvidenceCandidates.keys().next().value

          if (oldestSession === undefined) break
          rejectedEvidenceCandidates.delete(oldestSession)
        }

        return
      }

      if (rejected.includes(event.id)) return
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
      const admissionToken = Symbol(sessionID)
      const generation = generations.get(sessionID)

      inFlight.add(sessionID)
      admissionTokens.set(sessionID, admissionToken)

      try {
        if (!(await ownsSession(sessionID))) return
        const goal = await controller.get(sessionID)

        if (!goal || goal.status !== "active" || generation !== generations.get(sessionID)) return
        const before = goal.progressCount ?? 0
        const stillOwned = await ownsSession(sessionID)

        if (stopped || !stillOwned || generation !== generations.get(sessionID) || admissionTokens.get(sessionID) !== admissionToken) return
        const latest = await controller.get(sessionID)

        if (!latest || latest.status !== "active" || latest.createdAt !== goal.createdAt
          || generation !== generations.get(sessionID) || admissionTokens.get(sessionID) !== admissionToken) return

        pendingContinuations.set(sessionID, { before, createdAt: goal.createdAt, generation })

        try {
          // Once prompt admission starts, cancellation cannot retract a prompt that OpenCode accepts.
          await ctx.session.prompt({
            sessionID,
            text: "Continue the persisted goal from the latest checkpoint. Do not mark it complete without successful structured evidence.",
            metadata: { plugin: "opencode.goal", continuation: goal.continuationCount + 1 },
          })
        } catch (error) {
          if (admissionTokens.get(sessionID) === admissionToken) pendingContinuations.delete(sessionID)
          throw error
        }
      } finally {
        if (admissionTokens.get(sessionID) === admissionToken) admissionTokens.delete(sessionID)
        inFlight.delete(sessionID)

        if (rescheduleAfterAdmission.delete(sessionID) && generation === generations.get(sessionID)) await scheduleContinuation(sessionID)
      }
    }

    const settleContinuation = async (sessionID: string): Promise<void> => {
      if (!(await ownsSession(sessionID))) return
      const pending = pendingContinuations.get(sessionID)

      if (!pending || pending.generation !== generations.get(sessionID)) return
      pendingContinuations.delete(sessionID)
      const goal = await controller.get(sessionID)

      if (!goal || goal.createdAt !== pending.createdAt || pending.generation !== generations.get(sessionID)) return
      const accounted = await controller.account(sessionID, 0, true, (goal.progressCount ?? 0) > pending.before, pending.createdAt)

      if (accounted?.status === "usageLimited" || accounted?.status === "budgetLimited" || accounted?.status === "paused") {
        cancelContinuation(sessionID)
      }
    }

    const cancelContinuation = (sessionID: string): void => {
      generations.set(sessionID, Symbol(sessionID))
      admissionTokens.delete(sessionID)
      rescheduleAfterAdmission.delete(sessionID)
      pendingContinuations.delete(sessionID)
      const timer = scheduled.get(sessionID)

      if (timer !== undefined) clearTimeout(timer)
      scheduled.delete(sessionID)
    }

    const scheduleContinuation = async (sessionID: string): Promise<void> => {
      if (
        stopped
        || options.autoContinue === false
        || scheduled.has(sessionID)
        || inFlight.has(sessionID)
      ) return

      const generation = generations.get(sessionID)
      const goal = await controller.get(sessionID)

      if (!goal || goal.status !== "active") return
      const owned = await ownsSession(sessionID)

      if (stopped || !owned || scheduled.has(sessionID) || inFlight.has(sessionID)
        || generation !== generations.get(sessionID)) return

      const latest = await controller.get(sessionID)

      if (!latest || latest.status !== "active" || latest.createdAt !== goal.createdAt
        || generation !== generations.get(sessionID)) return

      const timer = setTimeout(() => {
        scheduled.delete(sessionID)

        if (generation !== generations.get(sessionID)) return
        void continueGoal(sessionID).catch(() => undefined)
      }, Math.max(0, options.continuationIntervalMs ?? 1500))

      scheduled.set(sessionID, timer)
    }

    const streamController = new AbortController()
    const stream = ctx.event.subscribe({ signal: streamController.signal })
    const iterator = stream[Symbol.asyncIterator]()

    const streamTask = (async () => {
      try {
        while (!stopped) {
          const item = await iterator.next()

          if (item.done) break
          const event = item.value

          if (event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
            const sessionID = event.data.sessionID

            if (!(await ownsSession(sessionID))) continue
            cancelContinuation(sessionID)
            const detail = event.type === "session.execution.failed" ? event.data.error.message : event.data.reason
            await controller.pauseAfterExecution(
              sessionID,
              event.type === "session.execution.failed" ? "failed" : "interrupted",
              detail,
            )
            continue
          }

          if (event.type !== "session.execution.succeeded") continue
          const sessionID = event.data.sessionID
          await settleContinuation(sessionID)

          if (inFlight.has(sessionID)) {
            if (admissionTokens.has(sessionID)) rescheduleAfterAdmission.add(sessionID)
            continue
          }

          await scheduleContinuation(sessionID)
        }
      } catch {
        if (!stopped) return
      }
    })()

    stopStream = async () => {
      streamController.abort()
      await iterator.return?.()
      await streamTask
    }

    return async () => {
      stopped = true

      for (const timer of scheduled.values()) clearTimeout(timer)
      scheduled.clear()
      admissionTokens.clear()
      generations.clear()
      rescheduleAfterAdmission.clear()
      evidenceCandidates.clear()
      rejectedEvidenceCandidates.clear()
      await stopStream?.()
      pendingContinuations.clear()
    }
  },
})
