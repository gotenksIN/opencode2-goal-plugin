import { createHash } from "node:crypto"
import { chmod, link, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { Goal } from "./types"

const lockRetryMs = 10

const lockTimeoutMs = 5000

export class GoalStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: StorageDomain,
    private readonly scope: { projectID: string; directory: string; workspaceID?: string },
    private readonly lockDirectory = join(homedir(), ".local", "share", "opencode-goal-plugin", "locks"),
  ) {}

  private key(sessionID: string): string {
    return `goal/v1/${JSON.stringify([this.scope.projectID, this.scope.directory, this.scope.workspaceID ?? null, sessionID])}`
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.lockDirectory, { recursive: true, mode: 0o700 })
    await chmod(this.lockDirectory, 0o700).catch(() => undefined)
  }

  private async read(sessionID: string): Promise<Goal | undefined> {
    const value = await this.storage.get(this.key(sessionID))

    if (value === undefined) return undefined
    const goal: Goal = JSON.parse(JSON.stringify(value))

    if (!goal || goal.sessionID !== sessionID) {
      throw new Error("Unsupported stored goal format")
    }

    return goal
  }

  private async acquireFileLock(sessionID: string): Promise<() => Promise<void>> {
    await this.ensureDirectory()
    const digest = createHash("sha256").update(this.key(sessionID)).digest("hex")
    const lockPath = join(this.lockDirectory, `${digest}.lock`)
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
    return this.read(sessionID)
  }

  update(sessionID: string, mutate: (goal: Goal | undefined) => Goal): Promise<Goal>
  update(sessionID: string, mutate: (goal: Goal | undefined) => Goal | undefined): Promise<Goal | undefined>
  update(sessionID: string, mutate: (goal: Goal | undefined) => Goal | undefined): Promise<Goal | undefined> {
    return this.locked(async () => {
      const release = await this.acquireFileLock(sessionID)

      try {
        const next = mutate(await this.read(sessionID))

        if (next) await this.storage.set(this.key(sessionID), JSON.parse(JSON.stringify(next)))
        else await this.storage.remove(this.key(sessionID))

        return structuredClone(next)
      } finally {
        await release()
      }
    })
  }
}
