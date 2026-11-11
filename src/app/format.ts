// Pure formatting helpers: time, tool descriptions, summaries. No DOM.

import type { AssistantPart, ToolState } from "./types"

export function basename(p?: string | null): string {
  if (!p) return ""
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function truncate(s: string, n: number): string {
  if (n <= 0) return ""
  s = s.replace(/\s+/g, " ").trim()
  if (s.length <= n) return s
  return n === 1 ? "…" : s.slice(0, n - 1) + "…"
}

function safeJson(v: unknown, space?: number): string {
  try {
    return JSON.stringify(v, null, space) ?? ""
  } catch {
    return String(v)
  }
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return "Just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.round(h / 24)
  if (d === 1) return "Yesterday"
  if (d < 7) return `${d} days ago`
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function host(url?: string) {
  try {
    return url ? new URL(url).host : ""
  } catch {
    return url ?? ""
  }
}

const pathOf = (input?: Record<string, any>) =>
  input?.path ?? input?.filePath ?? input?.file_path ?? input?.file ?? input?.target

function firstLine(s?: string) {
  return (s ?? "").split("\n").find((l) => l.trim()) ?? ""
}

function urlOf(input?: Record<string, any>): string | undefined {
  return input?.url ?? (Array.isArray(input?.urls) ? input.urls[0] : undefined)
}

/** Present-tense label for a running tool: "Reading sessions.ts…". */
export function describeTool(name: string, input?: Record<string, any>): string {
  const n = name.toLowerCase()
  switch (n) {
    case "read":
    case "read_file":
      return pathOf(input) ? `Reading ${basename(pathOf(input))}…` : "Reading…"
    case "edit":
    case "write":
    case "patch":
    case "apply_patch":
    case "multiedit":
    case "write_file":
    case "replace_in_file":
      return pathOf(input) ? `Editing ${basename(pathOf(input))}…` : "Editing…"
    case "shell":
    case "bash":
    case "terminal":
    case "process":
      return input?.description
        ? `${truncate(String(input.description), 44)}…`
        : input?.command
          ? `Running ${truncate(firstLine(input.command), 40)}…`
          : "Running a command…"
    case "grep":
    case "grep_search":
    case "search_files": {
      const q = input?.pattern ?? input?.query
      return q ? `Searching for ${truncate(String(q), 32)}…` : "Searching…"
    }
    case "glob":
    case "list":
    case "find_files":
      return input?.pattern ? `Finding ${truncate(String(input.pattern), 32)}…` : "Listing files…"
    case "websearch":
    case "web_search":
      return input?.query ? `Searching the web for ${truncate(String(input.query), 28)}…` : "Searching the web…"
    case "webfetch":
    case "web_extract":
    case "fetch_url":
      return `Fetching ${host(urlOf(input)) || "a page"}…`
    case "subagent":
    case "task":
    case "delegate_task": {
      const desc = input?.description ?? input?.goal ?? input?.task
      return desc ? `${truncate(String(desc), 44)}…` : "Running a subagent…"
    }
    case "skill":
    case "skill_view":
      return input?.name ? `Loading ${input.name}…` : "Loading a skill…"
    case "question":
    case "clarify":
      return "Waiting for your answer"
    case "todowrite":
    case "todo":
      return "Planning…"
    case "execute":
    case "execute_code":
      return "Running code…"
    default:
      return `Calling ${name.replace(/^.*\./, "")}…`
  }
}

/** Past-tense row for the expanded activity list: ["Read", "web/sessions.ts"]. */
export function toolRow(name: string, input?: Record<string, any>): [string, string] {
  const n = name.toLowerCase()
  switch (n) {
    case "read":
    case "read_file":
      return ["Read", String(pathOf(input) ?? "")]
    case "edit":
    case "patch":
    case "apply_patch":
    case "multiedit":
    case "replace_in_file":
      return ["Edited", String(pathOf(input) ?? "")]
    case "write":
    case "write_file":
      return ["Wrote", String(pathOf(input) ?? "")]
    case "shell":
    case "bash":
    case "terminal":
    case "process":
      return ["Ran", firstLine(input?.command) || String(input?.action ?? input?.session_id ?? "")]
    case "grep":
    case "grep_search":
    case "search_files":
      return ["Searched", String(input?.pattern ?? input?.query ?? pathOf(input) ?? "")]
    case "glob":
    case "list":
    case "find_files":
      return ["Listed", String(input?.pattern ?? pathOf(input) ?? "")]
    case "websearch":
    case "web_search":
      return ["Searched web", String(input?.query ?? "")]
    case "webfetch":
    case "web_extract":
    case "fetch_url":
      return ["Fetched", String(urlOf(input) ?? "")]
    case "subagent":
    case "task":
    case "delegate_task":
      return ["Subagent", String(input?.description ?? input?.goal ?? input?.prompt ?? input?.task ?? "")]
    case "skill":
    case "skill_view":
      return ["Loaded skill", String(input?.name ?? "")]
    case "question":
    case "clarify":
      return ["Asked", String(input?.question ?? input?.title ?? "")]
    case "todowrite":
    case "todo":
      return ["Planned", Array.isArray(input?.todos) ? `${input.todos.length} items` : ""]
    case "execute":
    case "execute_code":
      return ["Ran code", firstLine(input?.code)]
    default:
      return [name.replace(/^.*\./, ""), input ? truncate(safeJson(input), 120) : ""]
  }
}

type Bucket = "patch" | "run" | "read" | "search" | "fetch" | "subagent" | "skill" | "other"

const bucketOf = (name: string): Bucket => {
  switch (name.toLowerCase()) {
    case "edit":
    case "write":
    case "patch":
    case "apply_patch":
    case "multiedit":
    case "write_file":
    case "replace_in_file":
      return "patch"
    case "shell":
    case "bash":
    case "execute":
    case "terminal":
    case "process":
    case "execute_code":
      return "run"
    case "read":
    case "read_file":
      return "read"
    case "grep":
    case "glob":
    case "list":
    case "websearch":
    case "grep_search":
    case "search_files":
    case "find_files":
    case "web_search":
      return "search"
    case "webfetch":
    case "web_extract":
    case "fetch_url":
      return "fetch"
    case "subagent":
    case "task":
    case "delegate_task":
      return "subagent"
    case "skill":
    case "skill_view":
      return "skill"
    default:
      return "other"
  }
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`

/** "Patched 7 files, ran 12 commands, read 2 files" */
export function summarizeTools(tools: Array<{ name: string; input?: Record<string, any> }>): string {
  const counts = new Map<Bucket, number>()
  const files = new Map<Bucket, Set<string>>()
  for (const t of tools) {
    const b = bucketOf(t.name)
    counts.set(b, (counts.get(b) ?? 0) + 1)
    const p = pathOf(t.input)
    if (p && (b === "patch" || b === "read")) {
      if (!files.has(b)) files.set(b, new Set())
      files.get(b)!.add(String(p))
    }
  }
  const order: Bucket[] = ["patch", "run", "read", "search", "fetch", "subagent", "skill", "other"]
  const parts: string[] = []
  for (const b of order) {
    const c = counts.get(b)
    if (!c) continue
    const f = files.get(b)?.size || c
    switch (b) {
      case "patch":
        parts.push(`patched ${plural(f, "file")}`)
        break
      case "run":
        parts.push(`ran ${plural(c, "command")}`)
        break
      case "read":
        parts.push(`read ${plural(f, "file")}`)
        break
      case "search":
        parts.push(`searched ${plural(c, "pattern")}`)
        break
      case "fetch":
        parts.push(`fetched ${plural(c, "page")}`)
        break
      case "subagent":
        parts.push(`ran ${plural(c, "subagent")}`)
        break
      case "skill":
        parts.push(`loaded ${plural(c, "skill")}`)
        break
      default:
        parts.push(`called ${plural(c, "tool")}`)
    }
  }
  const s = parts.join(", ")
  return s ? s[0].toUpperCase() + s.slice(1) : ""
}

export function toolOutput(state: ToolState): string {
  if (state.status === "error") {
    const e = state.error
    return typeof e === "string" ? e : (e?.message ?? safeJson(e ?? {}, 2))
  }
  const text = (state.content ?? [])
    .map((c) => (c.type === "text" ? (c.text ?? "") : c.name ? `[${c.name}]` : `[${c.type}]`))
    .join("\n")
  return text
}

export function lastAssistantText(parts: AssistantPart[]): string {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p.type === "text" && p.text.trim()) return p.text
  }
  return ""
}

export function matchesQuery(q: string, ...fields: Array<string | undefined>): boolean {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const hay = fields.filter(Boolean).join("\n").toLowerCase()
  return terms.every((t) => hay.includes(t))
}
