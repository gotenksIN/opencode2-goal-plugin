import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { GoalController } from "../src/controller"
import { GoalStore } from "../src/store"
import { memoryStorage } from "./storage"

const lockDirectory = join(import.meta.dir, ".store-locks")

const scope = { projectID: "project", directory: "/project" }

afterEach(() => rm(lockDirectory, { recursive: true, force: true }))

describe("GoalStore", () => {
  test("persists isolated session state across store instances", async () => {
    const storage = memoryStorage()
    const first = new GoalController(new GoalStore(storage, scope, lockDirectory))
    await first.create("a", "First objective")
    await first.create("b", "Second objective")

    const restarted = new GoalController(new GoalStore(storage, scope, lockDirectory))
    expect((await restarted.get("a"))?.objective).toBe("First objective")
    expect((await restarted.get("b"))?.objective).toBe("Second objective")

    await restarted.clear("a")
    expect(await first.get("a")).toBeUndefined()
    expect((await first.get("b"))?.objective).toBe("Second objective")
  })

  test("isolates projects and worktrees with the same session ID", async () => {
    const storage = memoryStorage()
    const first = new GoalController(new GoalStore(storage, scope, lockDirectory))
    const otherProject = new GoalController(new GoalStore(storage, { ...scope, projectID: "other" }, lockDirectory))
    const otherWorktree = new GoalController(new GoalStore(storage, { ...scope, directory: "/worktree" }, lockDirectory))
    await first.create("s", "First objective")
    expect(await otherProject.get("s")).toBeUndefined()
    expect(await otherWorktree.get("s")).toBeUndefined()
  })

  test("preserves concurrent transitions from separate store instances", async () => {
    const storage = memoryStorage()
    const first = new GoalController(new GoalStore(storage, scope, lockDirectory))
    const second = new GoalController(new GoalStore(storage, scope, lockDirectory))
    await first.create("s", "Shared objective")

    await Promise.all([
      first.account("s", 10),
      second.account("s", 20),
    ])

    expect((await first.get("s"))?.tokenEstimate).toBe(30)
  })
})
