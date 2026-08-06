export const goalStatuses = [
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
] as const

export type GoalStatus = (typeof goalStatuses)[number]

export interface Evidence {
  source: "tool" | "test" | "verification"
  summary: string
  success: true
  toolCallID?: string
  createdAt: string
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
