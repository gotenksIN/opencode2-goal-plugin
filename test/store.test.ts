import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { GoalController } from "../src/controller"
import { GoalStore } from "../src/store"

const root = join(import.meta.dir, ".data")

afterEach(() => rm(root, { recursive: true, force: true }))

describe("GoalStore", () => {
  test("persists isolated session state with atomic replacement", async () => {
    const path = join(root, "goals.json")
    const controller = new GoalController(new GoalStore(path))
    await Promise.all([
      controller.create("a", "First objective"),
      controller.create("b", "Second objective"),
    ])
    expect((await controller.get("a"))?.objective).toBe("First objective")
    expect((await controller.get("b"))?.objective).toBe("Second objective")
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])

    if (process.platform !== "win32") {
      expect((await stat(root)).mode & 0o777).toBe(0o700)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  test("clears only the selected session", async () => {
    const controller = new GoalController(new GoalStore(join(root, "goals.json")))
    await controller.create("a", "A")
    await controller.create("b", "B")
    await controller.clear("a")
    expect(await controller.get("a")).toBeUndefined()
    expect((await controller.get("b"))?.objective).toBe("B")
  })

  test("preserves concurrent updates from separate store instances", async () => {
    const path = join(root, "shared.json")
    const first = new GoalController(new GoalStore(path))
    const second = new GoalController(new GoalStore(path))

    await Promise.all([
      first.create("a", "First objective"),
      second.create("b", "Second objective"),
    ])

    expect((await first.get("a"))?.objective).toBe("First objective")
    expect((await first.get("b"))?.objective).toBe("Second objective")
    expect((await readdir(root)).filter((name) => name.endsWith(".lock"))).toEqual([])
  })

  test("preserves an existing custom directory mode", async () => {
    await mkdir(root, { recursive: true, mode: 0o755 })
    await chmod(root, 0o755)
    const controller = new GoalController(new GoalStore(join(root, "custom.json"), false))
    await controller.create("s", "Custom path")

    if (process.platform !== "win32") expect((await stat(root)).mode & 0o777).toBe(0o755)
  })

  test("does not remove a stale lock owned by another process", async () => {
    await mkdir(root, { recursive: true })
    const path = join(root, "stale.json")
    const lockPath = `${path}.lock`
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "stale" }))
    const controller = new GoalController(new GoalStore(path))

    await expect(controller.create("s", "Blocked write")).rejects.toThrow("Remove stale goal store lock")
    expect(await readFile(lockPath, "utf8")).toContain("stale")
  })
})
