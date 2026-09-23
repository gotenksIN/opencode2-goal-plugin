import type { StorageDomain } from "@opencode/plugin/promise/storage"

export function memoryStorage(): StorageDomain {
  const values = new Map<string, Parameters<StorageDomain["set"]>[1]>()

  return {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    remove: async (key) => { values.delete(key) },
    scan: async ({ prefix }) => ({
      entries: [...values].flatMap(([key, value]) => key.startsWith(prefix) ? [{ key, value }] : []),
    }),
  }
}
