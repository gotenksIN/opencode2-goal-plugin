export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete"

export const evidenceSources = ["tool", "test", "verification"] as const

export type EvidenceSource = (typeof evidenceSources)[number]

export interface Evidence {
  source: EvidenceSource
  summary: string
  success: true
  toolCallID?: string
  createdAt: string
}

export type EvidenceInput = Omit<Evidence, "createdAt">

export interface EvidenceClaim {
  source: EvidenceSource
  summary: string
  success: boolean
  toolCallID?: string
}

export interface CreateGoalInput {
  objective: string
}

export interface GoalUpdateDetail {
  blocker?: string
  evidence?: EvidenceClaim
}

export interface UpdateGoalInput extends GoalUpdateDetail {
  action: "pause" | "resume" | "blocked" | "complete"
}

export interface Checkpoint {
  at: string
  summary: string
  source: string
}

export interface HistoryEntry {
  at: string
  action: string
  status: GoalStatus
  detail?: string
}

export interface Goal {
  sessionID: string
  objective: string
  status: GoalStatus
  blocker?: string
  evidence: Evidence[]
  checkpoints: Checkpoint[]
  history: HistoryEntry[]
  createdAt: string
  updatedAt: string
  activeSince?: string
  activeTimeMs: number
  continuationCount: number
  tokenEstimate: number
  noProgressCount: number
  progressCount?: number
}

export interface GoalLimits {
  maxContinuations?: number
  maxTokens?: number
  maxDurationMs?: number
  noProgressTurns?: number
}
