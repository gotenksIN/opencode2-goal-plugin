import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Goal, GoalDatabase } from "./types"

const emptyDatabase = (): GoalDatabase => ({ version: 1, goals: {} })

export class GoalStore {
  readonly path: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  private async readUnlocked(): Promise<GoalDatabase> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as GoalDatabase
      if (value.version !== 1 || !value.goals || typeof value.goals !== "object") {
        throw new Error("Unsupported goal database format")
      }
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDatabase()
      throw error
    }
  }

  private async writeUnlocked(database: GoalDatabase): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.path)
    } catch (error) {
      await import("node:fs/promises").then(({ unlink }) => unlink(temporary)).catch(() => undefined)
      throw error
    }
    await chmod(this.path, 0o600).catch(() => undefined)
  }

  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  get(sessionID: string): Promise<Goal | undefined> {
    return this.locked(async () => structuredClone((await this.readUnlocked()).goals[sessionID]))
  }

  all(): Promise<Record<string, Goal>> {
    return this.locked(async () => structuredClone((await this.readUnlocked()).goals))
  }

  update(sessionID: string, mutate: (goal: Goal | undefined) => Goal | undefined): Promise<Goal | undefined> {
    return this.locked(async () => {
      const database = await this.readUnlocked()
      const next = mutate(structuredClone(database.goals[sessionID]))
      if (next) database.goals[sessionID] = next
      else delete database.goals[sessionID]
      await this.writeUnlocked(database)
      return structuredClone(next)
    })
  }
}
