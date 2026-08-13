import type { EvidenceInput, Goal, GoalLimits, GoalStatus, GoalUpdateDetail } from "./types"
import { evidenceSources } from "./types"
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

export function validateEvidence(value: ReturnType<typeof JSON.parse>): EvidenceInput {
  if (value === null || value instanceof Object === false) {
    throw new Error("Completion requires structured evidence")
  }
  if (!evidenceSources.includes(value.source)) {
    throw new Error("Evidence source must be tool, test, or verification")
  }
  if (value.success !== true) throw new Error("Evidence must report success: true")
  let summary: string
  try {
    summary = value.summary.trim()
  } catch {
    throw new Error("Evidence requires a useful summary")
  }
  if (summary.length < 3) throw new Error("Evidence requires a useful summary")
  if (value.toolCallID !== undefined && String(value.toolCallID) !== value.toolCallID) {
    throw new Error("Evidence toolCallID must be a string")
  }
  const evidence: EvidenceInput = { source: value.source, summary, success: true }
  if (value.toolCallID) evidence.toolCallID = value.toolCallID
  return evidence
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
    })
  }

  clear(sessionID: string): Promise<Goal | undefined> {
    return this.store.update(sessionID, () => undefined)
  }

  update(sessionID: string, status: "pause" | "resume" | "blocked" | "complete", detail?: GoalUpdateDetail): Promise<Goal> {
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
    })
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
