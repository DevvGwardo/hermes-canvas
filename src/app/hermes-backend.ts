// HermesBackend: implements the Backend contract, served from the local
// Hermes session store (/api/hermes/*).
// Hermes has no permission/form/inbox queues, so those read empty and the
// corresponding replies are accepted no-ops.

import type {
  Delivery,
  FileAttachment,
  FormInfo,
  InboxItem,
  Message,
  ModelRef,
  PermissionRule,
  OcEvent,
  Page,
  PermissionDecision,
  PermissionRequest,
  Project,
  Session,
} from "./types"
import type { Backend, ConnectionState, ModelOption, PromptInput } from "./backend"
import { ApiError } from "./backend"

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = text
  }
  if (!res.ok) {
    const msg = (json && typeof json === "object" && (json.message || json._tag)) || `${res.status} ${res.statusText}`
    throw new ApiError(res.status, String(msg), json)
  }
  return json as T
}

const enc = encodeURIComponent

export class HermesBackend implements Backend {
  readonly kind = "live" as const

  async listProjects(): Promise<Project[]> {
    return (await request<Project[]>("GET", "/api/hermes/project")) ?? []
  }

  async listSessions(max: number): Promise<Session[]> {
    const page = await request<Page<Session>>("GET", `/api/hermes/session?limit=${Math.min(max, 600)}`)
    return page.data ?? []
  }

  async getSession(id: string): Promise<Session> {
    return request<Session>("GET", `/api/hermes/session/${enc(id)}`)
  }

  async searchSessions(query: string): Promise<Session[]> {
    const page = await request<Page<Session>>("GET", `/api/hermes/session?search=${enc(query)}`)
    return page.data ?? []
  }

  async active(): Promise<Set<string>> {
    const r = await request<Record<string, { type: string }>>("GET", "/api/hermes/session/active")
    return new Set(Object.entries(r ?? {}).filter(([, v]) => v?.type === "running").map(([k]) => k))
  }

  async messages(id: string, limit: number, cursor?: string): Promise<Page<Message>> {
    const q = cursor ? `cursor=${enc(cursor)}&limit=${limit}` : `limit=${limit}`
    return request<Page<Message>>("GET", `/api/hermes/session/${enc(id)}/message?${q}`)
  }

  async inbox(): Promise<InboxItem[]> {
    return []
  }

  async permissions(): Promise<PermissionRequest[]> {
    return []
  }

  async forms(): Promise<FormInfo[]> {
    return []
  }

  async createSession(directory: string, model?: ModelRef, permissions?: PermissionRule[]): Promise<Session> {
    const body: Record<string, unknown> = { location: { directory } }
    if (model) body.model = model
    if (permissions?.length) body.permissions = permissions
    return request<Session>("POST", "/api/hermes/session", body)
  }

  async listModels(): Promise<ModelOption[]> {
    const all = (await request<Array<{ id: string; providerID: string; name: string }>>("GET", "/api/hermes/model")) ?? []
    return all.map((m) => ({ id: String(m.id), providerID: String(m.providerID), name: String(m.name ?? m.id) }))
  }

  async serverDefaultModel(): Promise<ModelOption | undefined> {
    const m = await request<{ id: string; providerID: string; name: string } | null>("GET", "/api/hermes/model/default")
    return m?.id ? { id: String(m.id), providerID: String(m.providerID), name: String(m.name ?? m.id) } : undefined
  }

  async listFolders(path: string): Promise<string[]> {
    const r = await request<{ data: Array<{ path: string; type: string }> }>("GET", `/api/hermes/fs/list?path=${enc(path)}`)
    return (r.data ?? []).filter((e) => e.type === "directory").map((e) => e.path.replace(/\/+$/, ""))
  }

  async switchModel(id: string, model: ModelRef): Promise<void> {
    await request("POST", `/api/hermes/session/${enc(id)}/model`, { model })
  }

  async prompt(id: string, input: PromptInput): Promise<void> {
    const body: Record<string, unknown> = { text: input.text }
    if (input.delivery) body.delivery = input.delivery
    await request("POST", `/api/hermes/session/${enc(id)}/prompt`, body)
  }

  async interrupt(id: string): Promise<void> {
    await request("POST", `/api/hermes/session/${enc(id)}/interrupt`)
  }

  async markViewed(id: string, idle: number): Promise<void> {
    await request("POST", `/api/hermes/session/${enc(id)}/view`, { idle })
  }

  async setSessionPermissions(id: string, rules: PermissionRule[] | null): Promise<void> {
    await request("PATCH", `/api/hermes/session/${enc(id)}`, { permissions: rules })
  }

  async rename(id: string, title: string): Promise<void> {
    await request("PATCH", `/api/hermes/session/${enc(id)}`, { title })
  }

  async setInboxDelivery(): Promise<void> {}
  async cancelInbox(): Promise<void> {}
  async replyPermission(): Promise<void> {}
  async replyForm(): Promise<void> {}
  async cancelForm(): Promise<void> {}

  subscribe(onEvent: (ev: OcEvent) => void, onState: (s: ConnectionState) => void) {
    let es: EventSource | undefined
    let closed = false
    let retry = 500
    let timer: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      if (closed) return
      es = new EventSource("/api/hermes/event")
      es.onopen = () => {
        retry = 500
      }
      es.onmessage = (m) => {
        let ev: OcEvent
        try {
          ev = JSON.parse(m.data)
        } catch {
          return
        }
        if (ev.type === "server.connected") onState("live")
        onEvent(ev)
      }
      es.onerror = () => {
        es?.close()
        if (closed) return
        onState("reconnecting")
        timer = setTimeout(connect, retry)
        retry = Math.min(retry * 2, 10_000)
      }
    }
    onState("connecting")
    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      es?.close()
    }
  }
}

