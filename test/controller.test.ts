import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { GoalController, parseGoalCommand, validateEvidence } from "../src/controller"
import { GoalStore } from "../src/store"

const root = join(import.meta.dir, ".controller")
afterEach(() => rm(root, { recursive: true, force: true }))

describe("command parsing and evidence", () => {
  test("parses status, objective, and blocked commands", () => {
    expect(parseGoalCommand("status")).toEqual({ action: "get" })
    expect(parseGoalCommand("Ship feature")).toEqual({ action: "create", objective: "Ship feature" })
    expect(parseGoalCommand("blocked Need access")).toEqual({ action: "blocked", blocker: "Need access" })
  })

  test("accepts only structured successful evidence", () => {
    expect(validateEvidence({ source: "test", summary: "Tests passed", success: true }).success).toBe(true)
    expect(() => validateEvidence({ source: "test", summary: "Failed", success: false })).toThrow("success")
    expect(() => parseGoalCommand("complete done in prose")).toThrow("JSON")
  })
})

describe("goal lifecycle", () => {
  test("tracks transitions, checkpoints, and completion evidence", async () => {
    const controller = new GoalController(new GoalStore(join(root, "goals.json")))
    await controller.create("s", "Deliver result")
    await controller.checkpoint("s", "Code changed", "write")
    expect((await controller.update("s", "pause")).status).toBe("paused")
    expect((await controller.update("s", "resume")).status).toBe("active")
    expect((await controller.update("s", "blocked", { blocker: "Missing key" })).blocker).toBe("Missing key")
    await controller.update("s", "resume")
    await expect(controller.update("s", "complete", { evidence: { source: "test", summary: "Suite passed", success: false } })).rejects.toThrow()
    const complete = await controller.update("s", "complete", {
      evidence: { source: "test", summary: "Suite passed", success: true },
    })
    expect(complete.status).toBe("complete")
    expect(complete.evidence).toHaveLength(1)
    expect(complete.history.map((entry) => entry.action)).toContain("complete")
  })

  test("enforces continuation and no-progress limits", async () => {
    const controller = new GoalController(new GoalStore(join(root, "limits.json")), {
      maxContinuations: 2, maxTokens: 100, maxDurationMs: 100_000, noProgressTurns: 5,
    })
    await controller.create("s", "Bounded work")
    await controller.account("s", 1, true)
    const limited = await controller.account("s", 1, true)
    expect(limited?.status).toBe("budgetLimited")
    expect(limited?.continuationCount).toBe(2)
  })
})
