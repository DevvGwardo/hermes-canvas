// Model choice: the canvas remembers the last model you picked and uses it
// for sessions it creates. Unset means Hermes' own configured default.

import type { Backend, ModelOption } from "./backend"
import type { ModelRef } from "./types"

const KEY = "occ.model"

export function defaultModel(kind?: Backend["kind"]): ModelRef | undefined {
  try {
    const v = localStorage.getItem(KEY)?.trim()
    if (!v) return undefined
    const i = v.indexOf("/")
    if (i <= 0) return undefined
    const providerID = v.slice(0, i).trim()
    const id = v.slice(i + 1).trim()
    if (!providerID || !id) return undefined
    if (kind === "live" && providerID === "demo" && id === "demo-model") return undefined
    return { providerID, id }
  } catch {
    return undefined
  }
}

export function setDefaultModel(m: ModelRef | undefined) {
  try {
    const providerID = m?.providerID?.trim()
    const id = m?.id?.trim()
    if (providerID && id) localStorage.setItem(KEY, `${providerID}/${id}`)
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode */
  }
}

export const modelLabel = (m?: ModelRef | null) => (m?.id?.trim() ? m.id.trim() : "Default model")

// Caches are per-backend (WeakMap), not a single module singleton. Production
// uses exactly one Backend instance (main.ts), so this behaves identically
// there; but demo vs live backends no longer pollute each other, and tests
// get isolation for free by passing a fresh fake backend — no test-only
// export is needed to reach the rejection / per-backend paths.
const cacheByBackend = new WeakMap<Backend, Promise<ModelOption[]>>()

export function models(backend: Backend): Promise<ModelOption[]> {
  let cached = cacheByBackend.get(backend)
  if (!cached) {
    cached = backend.listModels().catch((e) => {
      cacheByBackend.delete(backend)
      throw e
    })
    cacheByBackend.set(backend, cached)
  }
  return cached
}

const defaultCacheByBackend = new WeakMap<Backend, Promise<ModelOption | undefined>>()

export function serverDefault(backend: Backend): Promise<ModelOption | undefined> {
  let cached = defaultCacheByBackend.get(backend)
  if (!cached) {
    cached = backend.serverDefaultModel().catch(() => {
      defaultCacheByBackend.delete(backend)
      return undefined
    })
    defaultCacheByBackend.set(backend, cached)
  }
  return cached
}
