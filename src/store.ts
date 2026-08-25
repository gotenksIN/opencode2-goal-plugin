import { chmod, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { Goal, GoalDatabase } from "./types"

const emptyDatabase = (): GoalDatabase => ({ version: 1, goals: {} })
const lockRetryMs = 10
const lockTimeoutMs = 5000

export class GoalStore {
  readonly path: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(path: string, private readonly protectDirectory = true) {
    this.path = path
  }

  private async ensureDirectory(): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (this.protectDirectory) await chmod(directory, 0o700).catch(() => undefined)
  }

  private async readUnlocked(): Promise<GoalDatabase> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"))
      if (value.version !== 1 || !value.goals || value.goals instanceof Object === false) {
        throw new Error("Unsupported goal database format")
      }
      return value
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyDatabase()
      throw error
    }
  }

  private async writeUnlocked(database: GoalDatabase): Promise<void> {
    await this.ensureDirectory()
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    await chmod(this.path, 0o600).catch(() => undefined)
  }

  private async acquireFileLock(): Promise<() => Promise<void>> {
    await this.ensureDirectory()
    const lockPath = `${this.path}.lock`
    const deadline = Date.now() + lockTimeoutMs
    const token = crypto.randomUUID()
    const candidate = `${lockPath}.${process.pid}.${token}.tmp`
    await writeFile(candidate, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 })
    while (Date.now() < deadline) {
      try {
        await link(candidate, lockPath)
        try {
          await unlink(candidate)
        } catch (error) {
          await unlink(lockPath).catch(() => undefined)
          await unlink(candidate).catch(() => undefined)
          throw error
        }
        return async () => {
          try {
            const lock = JSON.parse(await readFile(lockPath, "utf8"))
            if (lock.token === token) await unlink(lockPath)
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
          }
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
          await unlink(candidate).catch(() => undefined)
          throw error
        }
        try {
          const lock = JSON.parse(await readFile(lockPath, "utf8"))
          try {
            process.kill(lock.pid, 0)
          } catch (ownerError) {
            if (ownerError instanceof Error && "code" in ownerError && ownerError.code === "ESRCH") {
              throw new Error(`Remove stale goal store lock before retrying: ${lockPath}`)
            }
          }
        } catch (lockError) {
          if (!(lockError instanceof Error && "code" in lockError && lockError.code === "ENOENT")) {
            await unlink(candidate).catch(() => undefined)
            throw lockError
          }
        }
        await delay(lockRetryMs)
      }
    }
    await unlink(candidate).catch(() => undefined)
    throw new Error(`Timed out waiting for goal store lock: ${lockPath}`)
  }

  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  get(sessionID: string): Promise<Goal | undefined> {
    return this.locked(async () => structuredClone((await this.readUnlocked()).goals[sessionID]))
  }

  update(sessionID: string, mutate: (goal: Goal | undefined) => Goal): Promise<Goal>
  update(sessionID: string, mutate: (goal: Goal | undefined) => Goal | undefined): Promise<Goal | undefined>
  update(sessionID: string, mutate: (goal: Goal | undefined) => Goal | undefined): Promise<Goal | undefined> {
    return this.locked(async () => {
      const release = await this.acquireFileLock()
      try {
        const database = await this.readUnlocked()
        const next = mutate(structuredClone(database.goals[sessionID]))
        if (next) database.goals[sessionID] = next
        else delete database.goals[sessionID]
        await this.writeUnlocked(database)
        return structuredClone(next)
      } finally {
        await release()
      }
    })
  }
}
