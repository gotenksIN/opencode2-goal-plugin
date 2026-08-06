import type { Evidence, Goal, GoalLimits, GoalStatus } from "./types"
import { GoalStore } from "./store"

export const defaultLimits: GoalLimits = {
  maxContinuations: 12,
  maxTokens: 120_000,
  maxDurationMs: 60 * 60 * 1000,
  noProgressTurns: 3,
}

const now = () => new Date().toISOString()

function stopActiveClock(goal: Goal, at: string): void {
  if (!goal.activeSince) return
  goal.activeTimeMs += Math.max(0, Date.parse(at) - Date.parse(goal.activeSince))
  delete goal.activeSince
}

function history(goal: Goal, action: string, detail?: string): void {
  goal.history.push({ at: goal.updatedAt, action, status: goal.status, detail })
  goal.history = goal.history.slice(-100)
}

export function validateEvidence(value: unknown): Omit<Evidence, "createdAt"> {
  if (!value || typeof value !== "object") throw new Error("Completion requires structured evidence")
  const item = value as Record<string, unknown>
  if (!(["tool", "test", "verification"] as unknown[]).includes(item.source)) {
    throw new Error("Evidence source must be tool, test, or verification")
  }
  if (item.success !== true) throw new Error("Evidence must report success: true")
  if (typeof item.summary !== "string" || item.summary.trim().length < 3) {
    throw new Error("Evidence requires a useful summary")
  }
  if (item.toolCallID !== undefined && typeof item.toolCallID !== "string") {
    throw new Error("Evidence toolCallID must be a string")
  }
  return {
    source: item.source as Evidence["source"],
    summary: item.summary.trim(),
    success: true,
    ...(item.toolCallID ? { toolCallID: item.toolCallID } : {}),
  }
}

export type GoalCommand =
  | { action: "get" }
  | { action: "create"; objective: string }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "clear" }
  | { action: "blocked"; blocker: string }
  | { action: "complete"; evidence: Omit<Evidence, "createdAt"> }

export function parseGoalCommand(input: string): GoalCommand {
  const text = input.trim()
  if (!text || text === "status" || text === "get") return { action: "get" }
  const [action, ...rest] = text.split(/\s+/)
  const detail = rest.join(" ").trim()
  if (action === "create") {
    if (!detail) throw new Error("Usage: /goal create <objective>")
    return { action, objective: detail }
  }
  if (action === "pause" || action === "resume" || action === "clear") return { action }
  if (action === "blocked") {
    if (!detail) throw new Error("Usage: /goal blocked <blocker>")
    return { action, blocker: detail }
  }
  if (action === "complete") {
    let parsed: unknown
    try { parsed = JSON.parse(detail) } catch { throw new Error("Completion evidence must be JSON") }
    return { action, evidence: validateEvidence(parsed) }
  }
  return { action: "create", objective: text }
}

export class GoalController {
  constructor(readonly store: GoalStore, readonly limits: GoalLimits = defaultLimits) {}

  get(sessionID: string): Promise<Goal | undefined> {
    return this.store.get(sessionID)
  }

  create(sessionID: string, objective: string): Promise<Goal> {
    const clean = objective.trim()
    if (!clean) return Promise.reject(new Error("Objective is required"))
    return this.store.update(sessionID, (current) => {
      if (current && current.status !== "complete") throw new Error("This session already has a goal")
      const at = now()
      const goal: Goal = {
        sessionID, objective: clean, status: "active", evidence: [], checkpoints: [], history: [],
        createdAt: at, updatedAt: at, activeSince: at, activeTimeMs: 0,
        continuationCount: 0, tokenEstimate: 0, noProgressCount: 0,
      }
      history(goal, "created", clean)
      return goal
    }) as Promise<Goal>
  }

  clear(sessionID: string): Promise<undefined> {
    return this.store.update(sessionID, () => undefined) as Promise<undefined>
  }

  update(sessionID: string, status: "pause" | "resume" | "blocked" | "complete", detail?: { blocker?: string; evidence?: unknown }): Promise<Goal> {
    return this.store.update(sessionID, (goal) => {
      if (!goal) throw new Error("No goal exists for this session")
      if (goal.status === "complete") throw new Error("The goal is already complete")
      const at = now()
      goal.updatedAt = at
      if (status === "resume") {
        if (goal.status === "active") {
          history(goal, "resume", "Already active")
          return goal
        }
        goal.status = "active"
        goal.activeSince = at
        delete goal.blocker
        goal.noProgressCount = 0
      } else {
        stopActiveClock(goal, at)
        if (status === "pause") goal.status = "paused"
        if (status === "blocked") {
          if (!detail?.blocker?.trim()) throw new Error("Blocked status requires a blocker")
          goal.status = "blocked"
          goal.blocker = detail.blocker.trim()
        }
        if (status === "complete") {
          const evidence = validateEvidence(detail?.evidence)
          goal.evidence.push({ ...evidence, createdAt: at })
          goal.status = "complete"
        }
      }
      history(goal, status, detail?.blocker)
      return goal
    }) as Promise<Goal>
  }

  async handleCommand(sessionID: string, input: string): Promise<Goal | undefined> {
    const command = parseGoalCommand(input)
    if (command.action === "get") return this.get(sessionID)
    if (command.action === "create") return this.create(sessionID, command.objective)
    if (command.action === "clear") return this.clear(sessionID)
    if (command.action === "blocked") return this.update(sessionID, "blocked", command)
    if (command.action === "complete") return this.update(sessionID, "complete", command)
    return this.update(sessionID, command.action)
  }

  checkpoint(sessionID: string, summary: string, source: string, madeProgress = false): Promise<Goal | undefined> {
    return this.store.update(sessionID, (goal) => {
      if (!goal || goal.status !== "active") return goal
      goal.updatedAt = now()
      goal.checkpoints.push({ at: goal.updatedAt, summary, source })
      goal.checkpoints = goal.checkpoints.slice(-50)
      if (madeProgress) goal.noProgressCount = 0
      history(goal, "checkpoint", summary)
      return goal
    })
  }

  account(sessionID: string, tokenEstimate: number, continuation = false, madeProgress = false): Promise<Goal | undefined> {
    return this.store.update(sessionID, (goal) => {
      if (!goal || goal.status !== "active") return goal
      const at = now()
      goal.updatedAt = at
      goal.tokenEstimate += Math.max(0, Math.round(tokenEstimate))
      if (continuation) goal.continuationCount++
      goal.noProgressCount = madeProgress ? 0 : goal.noProgressCount + (continuation ? 1 : 0)
      const elapsed = goal.activeTimeMs + (goal.activeSince ? Date.parse(at) - Date.parse(goal.activeSince) : 0)
      let limited: GoalStatus | undefined
      if (goal.tokenEstimate >= this.limits.maxTokens) limited = "usageLimited"
      else if (elapsed >= this.limits.maxDurationMs || goal.continuationCount >= this.limits.maxContinuations) limited = "budgetLimited"
      else if (goal.noProgressCount >= this.limits.noProgressTurns) limited = "paused"
      if (limited) {
        stopActiveClock(goal, at)
        goal.status = limited
        history(goal, limited === "paused" ? "no-progress-pause" : "limit-reached")
      }
      return goal
    })
  }
}
