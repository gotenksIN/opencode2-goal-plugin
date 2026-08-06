import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { GoalController } from "../src/controller"
import { GoalStore } from "../src/store"

const root = join(import.meta.dir, ".data")
afterEach(() => rm(root, { recursive: true, force: true }))

describe("GoalStore", () => {
  test("persists isolated session state with atomic replacement", async () => {
    await mkdir(root, { recursive: true })
    const path = join(root, "goals.json")
    const controller = new GoalController(new GoalStore(path))
    await Promise.all([
      controller.create("a", "First objective"),
      controller.create("b", "Second objective"),
    ])
    expect((await controller.get("a"))?.objective).toBe("First objective")
    expect((await controller.get("b"))?.objective).toBe("Second objective")
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("clears only the selected session", async () => {
    const controller = new GoalController(new GoalStore(join(root, "goals.json")))
    await controller.create("a", "A")
    await controller.create("b", "B")
    await controller.clear("a")
    expect(await controller.get("a")).toBeUndefined()
    expect((await controller.get("b"))?.objective).toBe("B")
  })
})
