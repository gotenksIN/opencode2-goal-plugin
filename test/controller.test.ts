import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { GoalController } from "../src/controller"
import { GoalStore } from "../src/store"

const root = join(import.meta.dir, ".controller")

afterEach(() => rm(root, { recursive: true, force: true }))

describe("goal lifecycle", () => {
  test("tracks transitions, checkpoints, and completion evidence", async () => {
    const controller = new GoalController(new GoalStore(join(root, "goals.json")))
    await controller.create("s", "Deliver result")
    await controller.checkpoint("s", "Code changed", "write")
    expect((await controller.update("s", "pause")).status).toBe("paused")
    expect((await controller.update("s", "resume")).status).toBe("active")
    expect((await controller.update("s", "blocked", { blocker: "Missing key" })).blocker).toBe("Missing key")
    await controller.update("s", "resume")
    const proseEvidence = JSON.parse('"Suite passed"')
    await expect(controller.update("s", "complete", { evidence: proseEvidence })).rejects.toThrow("structured evidence")
    await expect(controller.update("s", "complete", { evidence: { source: "test", summary: "Suite passed", success: false } })).rejects.toThrow()
    await expect(controller.update("s", "complete", { evidence: { source: "test", summary: "Suite passed", success: true } })).rejects.toThrow("tool call ID")

    const complete = await controller.update("s", "complete", {
      evidence: { source: "test", summary: "Suite passed", success: true, toolCallID: "call-1" },
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

  test("tracks meaningful progress after old checkpoints are capped", async () => {
    const controller = new GoalController(new GoalStore(join(root, "progress.json")))
    await controller.create("s", "Long task")

    for (let index = 0; index < 51; index++) {
      await controller.checkpoint("s", `Read ${index}`, "read")
    }

    const progressed = await controller.checkpoint("s", "Changed code", "patch", true)

    expect(progressed?.checkpoints).toHaveLength(50)
    expect(progressed?.progressCount).toBe(1)
  })
})
