// Shapes served by the canvas servers (/api/hermes/*, /api/*).
// Only the fields the canvas reads are typed; everything else passes through.

export interface ModelRef {
  id: string
  providerID: string
  variant?: string
}

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface Session {
  id: string
  parentID?: string
  projectID: string
  agent?: string
  model?: ModelRef | null
  cost: number
  tokens: TokenUsage
  outcome?: "succeeded" | "failed" | "interrupted"
  time: { created: number; updated: number; idle?: number; viewed?: number; archived?: number }
  title?: string
  location: { directory: string }
  /** Session-level permission rules (Hermes backend: allow-all maps to --yolo). */
  permissions?: PermissionRule[] | null
}

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

export interface Project {
  id: string
  name?: string | null
  canonical: string
}

export interface ToolState {
  status: "streaming" | "running" | "completed" | "error"
  input?: Record<string, any>
  content?: Array<{ type: string; text?: string; uri?: string; mime?: string; name?: string }>
  metadata?: Record<string, any>
  error?: any
}

export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; time?: { created: number; completed?: number } }
  | { type: "tool"; id: string; name: string; state: ToolState; time: { created: number; ran?: number; completed?: number } }

export interface FileAttachment {
  data?: string
  uri?: string
  mime: string
  name?: string
  source?: { type: "inline" } | { type: "uri"; uri: string }
}

export type Message =
  | { type: "user"; id: string; time: { created: number }; text: string; files?: FileAttachment[] }
  | {
      type: "assistant"
      id: string
      time: { created: number; completed?: number }
      agent: string
      model: ModelRef
      content: AssistantPart[]
      finish?: string
      error?: { message?: string; type?: string; [k: string]: any }
    }
  | {
      type: "shell"
      id: string
      time: { created: number; completed?: number }
      command: string
      status: "running" | "exited" | "timeout" | "killed"
      exit?: number | string
      output?: { output: string; truncated: boolean }
    }
  | { type: "compaction"; id: string; time: { created: number }; [k: string]: any }
  | { type: "model-switched"; id: string; time: { created: number }; model?: ModelRef; [k: string]: any }
  | { type: "agent-switched"; id: string; time: { created: number }; agent?: string; [k: string]: any }
  | {
      type: "synthetic" | "system" | "skill" | "idle" | "location-switched"
      id: string
      time: { created: number }
      [k: string]: any
    }

export type Delivery = "steer" | "queue"

export interface InboxItem {
  id: string
  sessionID: string
  type: "user" | "synthetic" | "compaction" | "move"
  payload: { text?: string; [k: string]: any }
  delivery: Delivery
  time?: { created: number }
}

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, any>
}

export type PermissionDecision = "once" | "always" | "reject"

export interface FormOption {
  value: string
  label: string
  description?: string
}

export interface FormField {
  key: string
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external"
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  placeholder?: string
  default?: any
  options?: FormOption[]
  [k: string]: any
}

export interface FormInfo {
  id: string
  sessionID: string
  title: string
  fields: FormField[]
}

export interface OcEvent {
  id: string
  type: string
  created?: number
  data: any
  location?: { directory: string }
}

export interface Page<T> {
  data: T[]
  cursor?: { previous?: string | null; next?: string | null }
}
