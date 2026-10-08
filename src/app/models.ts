// Model choice: the canvas remembers the last model you picked and uses it
// for sessions it creates. Unset means OpenCode's own configured default.

import type { Backend, ModelOption } from "./backend"
import type { ModelRef } from "./types"

const KEY = "occ.model"

export function defaultModel(): ModelRef | undefined {
  try {
    const v = localStorage.getItem(KEY)
    if (!v) return undefined
    const i = v.indexOf("/")
    return i > 0 ? { providerID: v.slice(0, i), id: v.slice(i + 1) } : undefined
  } catch {
    return undefined
  }
}

export function setDefaultModel(m: ModelRef | undefined) {
  try {
    if (m) localStorage.setItem(KEY, `${m.providerID}/${m.id}`)
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode */
  }
}

export const modelLabel = (m?: ModelRef | null) => (m?.id ? m.id : "Default model")

let cache: Promise<ModelOption[]> | undefined

export function models(backend: Backend): Promise<ModelOption[]> {
  cache ??= backend.listModels().catch((e) => {
    cache = undefined
    throw e
  })
  return cache
}

let defaultCache: Promise<ModelOption | undefined> | undefined

export function serverDefault(backend: Backend): Promise<ModelOption | undefined> {
  defaultCache ??= backend.serverDefaultModel().catch(() => {
    defaultCache = undefined
    return undefined
  })
  return defaultCache
}
