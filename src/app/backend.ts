// Data source for the canvas. LiveBackend talks to OpenCode through the local
// proxy (/api/*); HermesBackend (hermes-backend.ts) talks to the local Hermes
// session store (/api/hermes/*); DemoBackend (demo.ts) implements the same
// contract in memory.

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

export type ConnectionState = "connecting" | "live" | "reconnecting" | "demo"

export interface PromptInput {
  text: string
  delivery?: Delivery
  files?: Array<{ uri: string; name?: string }>
}

export interface ModelOption {
  id: string
  providerID: string
  name: string
}

export interface Backend {
  readonly kind: "live" | "demo"
  listProjects(): Promise<Project[]>
  listSessions(max: number): Promise<Session[]>
  getSession(id: string): Promise<Session>
  searchSessions(query: string): Promise<Session[]>
  active(): Promise<Set<string>>
  messages(id: string, limit: number, cursor?: string): Promise<Page<Message>>
  inbox(id: string): Promise<InboxItem[]>
  permissions(id: string): Promise<PermissionRequest[]>
  forms(id: string): Promise<FormInfo[]>
  createSession(directory: string, model?: ModelRef, permissions?: PermissionRule[]): Promise<Session>
  setSessionPermissions(id: string, rules: PermissionRule[] | null): Promise<void>
  listModels(): Promise<ModelOption[]>
  /** The model the agent backend uses when a session doesn't pick one. */
  serverDefaultModel(): Promise<ModelOption | undefined>
  /** Subfolders of an absolute path; rejects if it isn't a readable folder. */
  listFolders(path: string): Promise<string[]>
  switchModel(id: string, model: ModelRef): Promise<void>
  prompt(id: string, input: PromptInput): Promise<void>
  interrupt(id: string): Promise<void>
  markViewed(id: string, idle: number): Promise<void>
  rename(id: string, title: string): Promise<void>
  setInboxDelivery(id: string, inboxID: string, delivery: Delivery): Promise<void>
  cancelInbox(id: string, inboxID: string): Promise<void>
  replyPermission(id: string, requestID: string, decision: PermissionDecision): Promise<void>
  replyForm(id: string, formID: string, answer: Record<string, unknown>): Promise<void>
  cancelForm(id: string, formID: string): Promise<void>
  subscribe(onEvent: (ev: OcEvent) => void, onState: (s: ConnectionState) => void): () => void
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message)
  }
}

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

// Most v2 endpoints wrap their payload in { data }.
const unwrap = <T>(r: { data: T } | T): T => (r && typeof r === "object" && "data" in (r as any) ? (r as any).data : r) as T

export class LiveBackend implements Backend {
  readonly kind = "live" as const

  async listProjects() {
    return unwrap(await request<Project[] | { data: Project[] }>("GET", "/api/project"))
  }

  async listSessions(max: number) {
    const out: Session[] = []
    let cursor: string | undefined
    while (out.length < max) {
      const limit = Math.min(200, max - out.length)
      const q = cursor ? `cursor=${enc(cursor)}&limit=${limit}` : `limit=${limit}&order=desc`
      const page = await request<Page<Session>>("GET", `/api/session?${q}`)
      out.push(...page.data)
      cursor = page.cursor?.next ?? undefined
      if (!cursor || page.data.length < limit) break
    }
    return out
  }

  async getSession(id: string) {
    return unwrap(await request<{ data: Session }>("GET", `/api/session/${enc(id)}`))
  }

  async searchSessions(query: string) {
    const page = await request<Page<Session>>("GET", `/api/session?search=${enc(query)}&limit=200&order=desc`)
    return page.data
  }

  async active() {
    const r = await request<{ data: Record<string, { type: string }> }>("GET", "/api/session/active")
    return new Set(Object.entries(r.data ?? {}).filter(([, v]) => v?.type === "running").map(([k]) => k))
  }

  async messages(id: string, limit: number, cursor?: string) {
    const q = cursor ? `cursor=${enc(cursor)}&limit=${limit}` : `limit=${limit}&order=desc`
    return request<Page<Message>>("GET", `/api/session/${enc(id)}/message?${q}`)
  }

  async inbox(id: string) {
    return unwrap(await request<{ data: InboxItem[] }>("GET", `/api/session/${enc(id)}/inbox`)) ?? []
  }

  async permissions(id: string) {
    return unwrap(await request<{ data: PermissionRequest[] }>("GET", `/api/session/${enc(id)}/permission`)) ?? []
  }

  async forms(id: string) {
    return unwrap(await request<{ data: FormInfo[] }>("GET", `/api/session/${enc(id)}/form`)) ?? []
  }

  async createSession(directory: string, model?: ModelRef, permissions?: PermissionRule[]) {
    const body: Record<string, unknown> = { location: { directory } }
    if (model) body.model = model
    if (permissions?.length) body.permissions = permissions
    return unwrap(await request<{ data: Session }>("POST", "/api/session", body))
  }

  async listModels() {
    const all = unwrap(await request<{ data: any[] }>("GET", "/api/model")) ?? []
    return all
      .filter((m) => m.enabled !== false && m.status !== "deprecated")
      .map((m) => ({ id: String(m.id), providerID: String(m.providerID), name: String(m.name ?? m.id) }))
  }

  async serverDefaultModel() {
    const r = await request<{ data: any }>("GET", "/api/model/default")
    const m = r?.data
    // Only the identity: this payload also carries provider credentials.
    return m?.id ? { id: String(m.id), providerID: String(m.providerID), name: String(m.name ?? m.id) } : undefined
  }

  async listFolders(path: string) {
    const r = await request<{ data: Array<{ path: string; type: string }> }>("GET", `/api/fs/list?path=${enc(path)}`)
    return (r.data ?? []).filter((e) => e.type === "directory").map((e) => e.path.replace(/\/+$/, ""))
  }

  async switchModel(id: string, model: ModelRef) {
    await request("POST", `/api/session/${enc(id)}/model`, { model })
  }

  async prompt(id: string, input: PromptInput) {
    const body: Record<string, unknown> = { text: input.text }
    if (input.delivery) body.delivery = input.delivery
    if (input.files?.length) body.files = input.files
    await request("POST", `/api/session/${enc(id)}/prompt`, body)
  }

  async interrupt(id: string) {
    await request("POST", `/api/session/${enc(id)}/interrupt`)
  }

  async markViewed(id: string, idle: number) {
    await request("POST", `/api/session/${enc(id)}/view`, { idle })
  }

  async setSessionPermissions(id: string, rules: PermissionRule[] | null) {
    await request("PATCH", `/api/session/${enc(id)}`, { permissions: rules })
  }

  async rename(id: string, title: string) {
    await request("PATCH", `/api/session/${enc(id)}`, { title })
  }

  async setInboxDelivery(id: string, inboxID: string, delivery: Delivery) {
    await request("PATCH", `/api/session/${enc(id)}/inbox/${enc(inboxID)}`, { delivery })
  }

  async cancelInbox(id: string, inboxID: string) {
    await request("DELETE", `/api/session/${enc(id)}/inbox/${enc(inboxID)}`)
  }

  async replyPermission(id: string, requestID: string, decision: PermissionDecision) {
    await request("POST", `/api/session/${enc(id)}/permission/${enc(requestID)}/reply`, { decision })
  }

  async replyForm(id: string, formID: string, answer: Record<string, unknown>) {
    await request("POST", `/api/session/${enc(id)}/form/${enc(formID)}/reply`, { answer })
  }

  async cancelForm(id: string, formID: string) {
    await request("DELETE", `/api/session/${enc(id)}/form/${enc(formID)}`)
  }

  subscribe(onEvent: (ev: OcEvent) => void, onState: (s: ConnectionState) => void) {
    let es: EventSource | undefined
    let closed = false
    let retry = 500
    let timer: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      if (closed) return
      es = new EventSource("/api/event")
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
        // EventSource retries on its own, but not after a 502 from the proxy;
        // own the backoff so both cases recover.
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

export function attachmentSrc(f: FileAttachment): string | undefined {
  if (f.uri) return f.uri
  if (f.source && f.source.type === "uri") return f.source.uri
  if (f.data) return `data:${f.mime};base64,${f.data}`
  return undefined
}
