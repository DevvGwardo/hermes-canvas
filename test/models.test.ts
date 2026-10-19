import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Backend, ModelOption } from "../src/app/backend"
import { defaultModel, modelLabel, models, serverDefault, setDefaultModel } from "../src/app/models"
import type { ModelRef } from "../src/app/types"

// models.ts is the canvas's model memory: the last-picked model persists under
// `occ.model`, and the model lists are promise-cached at module level with a
// reset-on-rejection so a failed fetch can be retried. Everything runs against
// bare globals (localStorage) and module state, so the storage fake is installed
// per test, and each cache contract lives in ONE test that owns its cache state
// (the caches are module-level: once a test resolves them, no other test can
// drive the rejection path).

const KEY = "occ.model"

type Storage = {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
  dump(): Record<string, string>
}

function memStorage(initial: Record<string, string> = {}): Storage {
  const data = { ...initial }
  return {
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v
    },
    removeItem: (k) => {
      delete data[k]
    },
    dump: () => ({ ...data }),
  }
}

function deniedStorage() {
  const deny = () => {
    throw new Error("denied")
  }
  return { getItem: deny, setItem: deny, removeItem: deny }
}

/** Just the two methods models.ts calls; the rest of Backend is irrelevant. */
function fakeBackend(
  parts: {
    listModels?: () => Promise<ModelOption[]>
    serverDefaultModel?: () => Promise<ModelOption | undefined>
  } = {},
): Backend {
  return {
    kind: "demo",
    listModels: parts.listModels ?? (() => Promise.resolve([])),
    serverDefaultModel: parts.serverDefaultModel ?? (() => Promise.resolve(undefined)),
  } as unknown as Backend
}

const g = globalThis as Record<string, unknown>
const original = { localStorage: g.localStorage }

beforeEach(() => {
  g.localStorage = memStorage()
})

afterEach(() => {
  if (original.localStorage === undefined) delete g.localStorage
  else g.localStorage = original.localStorage
})

describe("last-picked model persistence", () => {
  test("round-trips provider/id under the occ.model key", () => {
    setDefaultModel({ providerID: "anthropic", id: "claude-sonnet-4-5" })
    const store = (g.localStorage as Storage).dump()
    expect(store[KEY]).toBe("anthropic/claude-sonnet-4-5")
    expect(defaultModel()).toEqual({ providerID: "anthropic", id: "claude-sonnet-4-5" })
  })

  test("starts unset and treats malformed stored values as unset", () => {
    expect(defaultModel()).toBeUndefined() // nothing stored yet
    const store = g.localStorage as Storage
    for (const bad of ["", "no-slash-at-all", "/id-without-provider", "/"]) {
      store.setItem(KEY, bad)
      expect(defaultModel()).toBeUndefined()
    }
  })

  test("splits on the FIRST slash only, so ids may contain slashes", () => {
    const store = g.localStorage as Storage
    store.setItem(KEY, "openrouter/org/model-name:variant")
    expect(defaultModel()).toEqual({ providerID: "openrouter", id: "org/model-name:variant" })
  })

  test("clearing the choice removes the key entirely", () => {
    setDefaultModel({ providerID: "p", id: "m" })
    setDefaultModel(undefined)
    expect((g.localStorage as Storage).dump()[KEY]).toBeUndefined()
    expect(defaultModel()).toBeUndefined()
  })

  test("a denying store (private mode) never breaks read or write", () => {
    g.localStorage = deniedStorage()
    expect(defaultModel()).toBeUndefined()
    expect(() => setDefaultModel({ providerID: "p", id: "m" })).not.toThrow()
    expect(() => setDefaultModel(undefined)).not.toThrow()
  })
})

describe("modelLabel()", () => {
  test("falls back to the placeholder when there is no usable id", () => {
    expect(modelLabel(undefined)).toBe("Default model")
    expect(modelLabel(null)).toBe("Default model")
    expect(modelLabel({ providerID: "p", id: "" })).toBe("Default model")
  })

  test("shows the model id, not the provider", () => {
    expect(modelLabel({ providerID: "anthropic", id: "claude-sonnet-4-5" })).toBe("claude-sonnet-4-5")
  })
})

describe("models() promise cache", () => {
  test("retries after a rejection, then serves one shared promise", async () => {
    let calls = 0
    const failing = fakeBackend({
      listModels: () => {
        calls++
        return Promise.reject(new Error("boom"))
      },
    })
    await expect(models(failing)).rejects.toThrow("boom")
    expect(calls).toBe(1)

    const options: ModelOption[] = [{ id: "m1", providerID: "p1", name: "Model One" }]
    const good = fakeBackend({
      listModels: () => {
        calls++
        return Promise.resolve(options)
      },
    })
    const first = models(good)
    expect(calls).toBe(2) // the rejection reset the cache, so this fetched again
    expect(models(good)).toBe(first) // identity: everyone shares the one promise
    await expect(first).resolves.toEqual(options)

    const other = fakeBackend({
      listModels: () => {
        calls++
        return Promise.resolve([])
      },
    })
    expect(models(other)).toBe(first) // a successful result is served forever
    expect(calls).toBe(2)
  })
})

describe("serverDefault() promise cache", () => {
  test("a failed fetch resolves undefined (no rejection) and retries next time", async () => {
    let calls = 0
    const failing = fakeBackend({
      serverDefaultModel: () => {
        calls++
        return Promise.reject(new Error("nope"))
      },
    })
    // Callers (picker.ts) await serverDefault() without a catch - the swallow
    // and the cache reset both happen inside models.ts.
    await expect(serverDefault(failing)).resolves.toBeUndefined()
    expect(calls).toBe(1)

    const def: ModelOption = { id: "m0", providerID: "p0", name: "Server Default" }
    const good = fakeBackend({
      serverDefaultModel: () => {
        calls++
        return Promise.resolve(def)
      },
    })
    const first = serverDefault(good)
    expect(calls).toBe(2)
    expect(serverDefault(good)).toBe(first)
    await expect(first).resolves.toEqual(def)
    expect(serverDefault(good)).toBe(first) // cached after success
    expect(calls).toBe(2)
  })
})
