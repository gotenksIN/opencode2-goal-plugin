export const goalStatuses = [
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
] as const

export type GoalStatus = (typeof goalStatuses)[number]

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
}

export interface GoalDatabase {
  version: 1
  goals: Record<string, Goal>
}

export interface GoalLimits {
  maxContinuations: number
  maxTokens: number
  maxDurationMs: number
  noProgressTurns: number
}

export interface GoalOptions extends Partial<GoalLimits> {
  autoContinue?: boolean
  continuationIntervalMs?: number
  dataFile?: string
}
