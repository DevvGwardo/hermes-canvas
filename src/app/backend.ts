// Data source for the canvas. HermesBackend (hermes-backend.ts) talks to the
// local Hermes session store (/api/hermes/*); DemoBackend (demo.ts) implements
// the same contract in memory. (OpenCode-era LiveBackend was removed — it was
// instantiated nowhere; "live" now means the Hermes live store.)

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
  /** Basenames of subfolders of an absolute path; rejects if it isn't a readable folder. */
  listFolders(path: string): Promise<string[]>
  /** Sync global auto-approve (--yolo) state with the backend when supported. */
  setAutoApproveAll?(on: boolean): Promise<void>
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
    this.name = "ApiError"
  }
}

export function attachmentSrc(f: FileAttachment): string | undefined {
  if (f.uri) return f.uri
  if (f.source && f.source.type === "uri") return f.source.uri
  if (f.data) return `data:${f.mime};base64,${f.data}`
  return undefined
}
