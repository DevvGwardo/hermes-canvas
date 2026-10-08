// Hermes session-store adapter for hermes-canvas.
//
// Hermes (the Hermes Agent CLI) keeps sessions in a SQLite database
// (<hermes-home>/state.db, WAL mode) instead of an HTTP service, so this
// module is the equivalent of opencode-canvas's upstream proxy: it reads
// sessions/messages straight from the DB, spawns `hermes chat` subprocesses
// for steering, and translates everything into the canvas event vocabulary.
//
// Env overrides (also used by tests):
//   HERMES_HOME  Hermes home dir containing state.db (default per-platform)
//   HERMES_BIN   `hermes` executable (default: resolved from PATH)

import { Database } from "bun:sqlite"
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface CanvasEvent {
  id: string
  type: string
  created: number
  data: any
}

type Listener = (ev: CanvasEvent) => void

let seq = 0
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`

export function hermesHome(): string {
  const env = process.env.HERMES_HOME
  if (env) return env
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    return join(base, "hermes")
  }
  return join(homedir(), ".hermes")
}

export function dbPath(): string {
  return process.env.HERMES_CANVAS_DB ?? join(hermesHome(), "state.db")
}

export function hermesBin(): string {
  return process.env.HERMES_BIN ?? "hermes"
}

/** Split HERMES_BIN so tests (or wrappers) can point at `bun fake-hermes.ts`. */
function hermesArgv(): string[] {
  const bin = hermesBin()
  // Quoted segments stay together: bun "/path/with space/fake.ts"
  const parts = bin.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [bin]
  return parts.map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p))
}

interface ChatLauncher {
  argv: string[]
  env?: Record<string, string>
}

let chatLauncher: Promise<ChatLauncher> | undefined

/**
 * `hermes` on PATH can be broken for model work: the Hermes-managed Python
 * lacks binary wheels (pydantic_core), so `chat` fails at client init while
 * read-only commands like `sessions` still work. Detect that case and run
 * chat through the managed python with the real site-packages on PYTHONPATH
 * (the same recipe the gateway launcher uses). Everything is derived at
 * runtime: HERMES_BIN wins when set.
 */
function resolveChatLauncher(): Promise<ChatLauncher> {
  if (process.env.HERMES_BIN) return Promise.resolve({ argv: hermesArgv() })
  chatLauncher ??= (async (): Promise<ChatLauncher> => {
    const plain: ChatLauncher = { argv: ["hermes"] }
    try {
      const { Glob } = await import("bun")
      const home = hermesHome()
      // Site-packages dir from `hermes --version` ("Install directory: …").
      const ver = await runRaw(["hermes", "--version"], 15_000)
      const siteMatch = `${ver.out}\n${ver.err}`.match(/Install directory:\s*(.+)/)
      const site = process.env.HERMES_SITE_PACKAGES ?? siteMatch?.[1]?.trim()
      if (!site) return plain
      // Candidate interpreters: explicit > python owning site-packages >
      // PATH pythons > Hermes-managed python. Each must import the agent
      // AND its native wheels (pydantic_core) — the managed 3.14 cannot use
      // wheels built for other versions, which is exactly the failure mode
      // this guards against.
      const cands: string[] = []
      if (process.env.HERMES_PYTHON) cands.push(process.env.HERMES_PYTHON)
      cands.push(join(dirname(site), "..", "python.exe"), join(dirname(site), "..", "bin", "python3"))
      cands.push("python3", "python")
      const glob = new Glob("python-*/python.exe")
      const managed: string[] = []
      try {
        for await (const f of glob.scan({ cwd: join(home, "tools"), absolute: true, onlyFiles: true })) managed.push(f)
      } catch { /* no tools dir */ }
      managed.sort().reverse()
      cands.push(...managed)
      const env = { PYTHONPATH: site, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
      for (const py of cands) {
        try {
          const check = await runRaw([py, "-c", "import hermes_cli.main, pydantic_core; print('ok')"], 20_000, env)
          if (check.code === 0 && check.out.includes("ok")) {
            return { argv: [py, "-m", "hermes_cli.main"], env }
          }
        } catch { /* try next */ }
      }
      return plain
    } catch {
      return plain
    }
  })()
  return chatLauncher
}

async function runRaw(cmd: string[], timeoutMs: number, env?: Record<string, string>) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, ...env } })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [out, err] = await Promise.all([
    proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : Promise.resolve(""),
  ])
  await proc.exited
  clearTimeout(timer)
  return { code: proc.exitCode ?? 1, out: out.trim(), err: err.trim() }
}

function openDb(readonly: boolean): Database {
  const db = readonly ? new Database(dbPath(), { readonly: true }) : new Database(dbPath());
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  } catch { /* ignore */ }
  return db
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string
  source: string | null
  model: string | null
  billing_provider: string | null
  parent_session_id: string | null
  started_at: number | null
  ended_at: number | null
  end_reason: string | null
  message_count: number | null
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  cwd: string | null
  git_repo_root: string | null
  estimated_cost_usd: number | null
  actual_cost_usd: number | null
  title: string | null
  archived: number | null
  hidden: number | null
}

export interface CanvasSession {
  id: string
  parentID?: string
  projectID: string
  agent?: string
  model?: { id: string; providerID: string; name?: string } | null
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  outcome?: "succeeded" | "failed" | "interrupted"
  time: { created: number; updated: number; idle?: number; viewed?: number }
  title?: string
  location: { directory: string }
  permissions?: null
}

export function sessionDir(r: Pick<SessionRow, "git_repo_root" | "cwd" | "source">): string {
  const dir = r.git_repo_root || r.cwd
  if (dir) return dir
  return join(homedir(), r.source ? `hermes-${r.source}` : "hermes")
}

export function projectIDFor(dir: string): string {
  let h = 0
  for (let i = 0; i < dir.length; i++) h = (Math.imul(h, 31) + dir.charCodeAt(i)) | 0
  return `h_${(h >>> 0).toString(36)}`
}

export function projectNameFor(dir: string, source?: string | null): string {
  const base = dir.split(/[/\\]/).filter(Boolean).pop()
  if (base && !base.startsWith("hermes-")) return base
  return source ? `hermes/${source}` : "hermes"
}

export function parseModel(model: string | null, billingProvider: string | null): { id: string; providerID: string; name: string } {
  const raw = (model ?? "").trim() || (billingProvider ?? "").trim() || "hermes"
  const slash = raw.indexOf("/")
  if (slash > 0) return { id: raw.slice(slash + 1), providerID: raw.slice(0, slash), name: raw }
  return { id: raw, providerID: billingProvider?.trim() || "hermes", name: raw }
}

const s = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const ms = (v: number | null): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) : undefined

export function mapSession(
  r: SessionRow,
  extra?: { lastMsgAt?: number; running?: boolean; viewed?: number },
): CanvasSession {
  const dir = sessionDir(r)
  const created = ms(r.started_at) ?? Date.now()
  const updated = extra?.lastMsgAt ?? created
  const ended = r.ended_at != null || r.end_reason != null
  // A session that ended (or was reaped) is done; a live one with no running
  // turn is idle-but-open, so the canvas shows it as to-review/done rather
  // than stuck working.
  const idle = extra?.running ? undefined : ended || extra?.lastMsgAt ? (extra?.lastMsgAt ?? ms(r.ended_at) ?? created) : undefined
  return {
    id: r.id,
    parentID: r.parent_session_id ?? undefined,
    projectID: projectIDFor(dir),
    agent: r.source ?? "hermes",
    model: parseModel(r.model, r.billing_provider),
    cost: s(r.actual_cost_usd) || s(r.estimated_cost_usd),
    tokens: {
      input: s(r.input_tokens),
      output: s(r.output_tokens),
      reasoning: s(r.reasoning_tokens),
      cache: { read: s(r.cache_read_tokens), write: s(r.cache_write_tokens) },
    },
    outcome: ended ? "succeeded" : undefined,
    time: { created, updated, idle, viewed: extra?.viewed },
    title: r.title ?? undefined,
    location: { directory: dir },
    permissions: null,
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

interface MessageRow {
  id: number
  role: string
  content: string | null
  tool_call_id: string | null
  tool_calls: string | null
  tool_name: string | null
  timestamp: number | null
  finish_reason: string | null
  reasoning: string | null
}

const TOOL_TEXT_CAP = 24_000

function capText(t: string): string {
  return t.length > TOOL_TEXT_CAP ? t.slice(0, TOOL_TEXT_CAP) + "\n…[truncated]" : t
}

/** Hermes stores tool results as JSON envelopes like {"output": "...", "exit_code": 0}.
 *  Show the human part instead of the raw envelope. */
export function prettyToolText(content: string): string {
  const t = content.trim()
  if (t.startsWith("{") && t.endsWith("}")) {
    try {
      const o = JSON.parse(t)
      if (o && typeof o === "object") {
        if (typeof o.output === "string" && o.output) return o.output
        if (typeof o.error === "string" && o.error) return `error: ${o.error}`
      }
    } catch { /* not JSON: fall through */ }
  }
  return content
}

function parseToolCalls(raw: string | null): Array<{ id: string; name: string; input?: Record<string, any> }> {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.map((t: any, i: number) => ({
      id: String(t?.call_id ?? t?.id ?? `tc_${i}`),
      name: String(t?.function?.name ?? t?.name ?? "tool"),
      input: typeof t?.function?.arguments === "string" ? safeJson(t.function.arguments) : (t?.function?.arguments ?? t?.input),
    }))
  } catch {
    return []
  }
}

function safeJson(t: string): any {
  try {
    return JSON.parse(t)
  } catch {
    return { _raw: t.slice(0, 2000) }
  }
}

/** Map one page (newest-first) of Hermes message rows to canvas messages. */
export function mapMessages(rows: MessageRow[], agent: string, model: { id: string; providerID: string }): any[] {
  // Rows arrive newest-first; build oldest-first so tool results attach to
  // the assistant turn that issued them, then reverse back.
  const asc = [...rows].reverse()
  const out: any[] = []
  let currentAssistant: any | undefined

  // IDs derive from raw row ids so refetches and older-pages agree.
  const newAssistant = (ts: number, rowId: number | string) => {
    currentAssistant = {
      type: "assistant",
      id: `hma_${rowId}`,
      time: { created: ts },
      agent,
      model,
      content: [],
    }
    out.push(currentAssistant)
    return currentAssistant
  }

  for (const r of asc) {
    const ts = ms(r.timestamp) ?? Date.now()
    if (r.role === "user") {
      currentAssistant = undefined
      out.push({ type: "user", id: `hm_${r.id}`, time: { created: ts }, text: r.content ?? "" })
    } else if (r.role === "assistant") {
      const a = newAssistant(ts, r.id)
      if (r.reasoning) a.content.push({ type: "reasoning", text: r.reasoning })
      if (r.content) a.content.push({ type: "text", text: r.content })
      for (const tc of parseToolCalls(r.tool_calls)) {
        a.content.push({
          type: "tool",
          id: tc.id,
          name: tc.name,
          state: { status: "completed", input: tc.input, content: [{ type: "text", text: "(pending result)" }] },
          time: { created: ts },
        })
      }
      if (r.finish_reason && r.finish_reason !== "stop" && r.finish_reason !== "tool_calls") {
        a.finish = r.finish_reason
      }
    } else if (r.role === "tool") {
      const a = currentAssistant ?? newAssistant(ts, `t_${r.id}`)
      const text = capText(prettyToolText(r.content ?? ""))
      const part = a.content.find((p: any) => p.type === "tool" && p.id === r.tool_call_id)
      if (part) {
        part.state = { status: "completed", input: part.state?.input, content: [{ type: "text", text }] }
      } else {
        a.content.push({
          type: "tool",
          id: r.tool_call_id ?? `hm_${r.id}`,
          name: r.tool_name ?? "tool",
          state: { status: "completed", content: [{ type: "text", text }] },
          time: { created: ts },
        })
      }
    } else {
      currentAssistant = undefined
      out.push({ type: "system", id: `hm_${r.id}`, time: { created: ts }, text: r.content ?? "", role: r.role })
    }
  }
  return out.reverse()
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SESSION_COLS = `id, source, model, billing_provider, parent_session_id, started_at, ended_at,
  end_reason, message_count, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
  cache_write_tokens, cwd, git_repo_root, estimated_cost_usd, actual_cost_usd, title, archived, hidden`

function lastMsgMap(db: Database): Map<string, number> {
  const m = new Map<string, number>()
  try {
    for (const r of db.query("SELECT session_id, MAX(timestamp) t FROM messages GROUP BY session_id").all() as Array<{ session_id: string; t: number }>) {
      if (typeof r.t === "number") m.set(r.session_id, Math.round(r.t * 1000))
    }
  } catch { /* fresh/empty db */ }
  return m
}

export function listSessions(max: number, viewed: Map<string, number>, running: Set<string>): CanvasSession[] {
  const db = openDb(true)
  try {
    const rows = db.query(`SELECT ${SESSION_COLS} FROM sessions WHERE COALESCE(archived,0)=0 AND COALESCE(hidden,0)=0 ORDER BY started_at DESC LIMIT ?`).all(max) as SessionRow[]
    const last = lastMsgMap(db)
    return rows.map((r) =>
      mapSession(r, { lastMsgAt: last.get(r.id), running: running.has(r.id), viewed: viewed.get(r.id) }),
    )
  } finally {
    db.close()
  }
}

export function getSession(id: string, viewed: Map<string, number>, running: Set<string>): CanvasSession | undefined {
  const db = openDb(true)
  try {
    const r = db.query(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`).get(id) as SessionRow | null
    if (!r) return undefined
    let last: number | undefined
    try {
      const row = db.query("SELECT MAX(timestamp) t FROM messages WHERE session_id = ?").get(id) as { t: number | null } | null
      if (row && typeof row.t === "number") last = Math.round(row.t * 1000)
    } catch { /* ignore */ }
    return mapSession(r, { lastMsgAt: last, running: running.has(id), viewed: viewed.get(id) })
  } finally {
    db.close()
  }
}

export function listProjects(): Array<{ id: string; name: string; canonical: string }> {
  const db = openDb(true)
  try {
    let rows: Array<{ d: string; source: string | null }> = []
    try {
      rows = db.query(
        `SELECT COALESCE(git_repo_root, cwd) d, source FROM sessions
         WHERE COALESCE(archived,0)=0 AND COALESCE(hidden,0)=0 AND COALESCE(git_repo_root, cwd) IS NOT NULL
         GROUP BY d ORDER BY MAX(started_at) DESC`,
      ).all() as typeof rows
    } catch { /* ignore */ }
    const seen = new Set<string>()
    const out: Array<{ id: string; name: string; canonical: string }> = []
    for (const r of rows) {
      if (!r.d || seen.has(r.d)) continue
      seen.add(r.d)
      out.push({ id: projectIDFor(r.d), name: projectNameFor(r.d), canonical: r.d })
    }
    return out
  } finally {
    db.close()
  }
}

export function sessionMessages(id: string, limit: number, cursor?: string): { data: any[]; cursor?: { next?: string | null } } {
  const db = openDb(true)
  try {
    const sess = db.query("SELECT source, model, billing_provider FROM sessions WHERE id = ?").get(id) as {
      source: string | null; model: string | null; billing_provider: string | null
    } | null
    if (!sess) return { data: [] }
    const model = parseModel(sess.model, sess.billing_provider)
    const agent = sess.source ?? "hermes"
    const sel = `SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason, reasoning
         FROM messages WHERE session_id = ?`
    const page = (before?: string, n?: number): MessageRow[] =>
      (before
        ? db.query(`${sel} AND id < ? ORDER BY id DESC LIMIT ?`).all(id, Number(before), n ?? limit)
        : db.query(`${sel} ORDER BY id DESC LIMIT ?`).all(id, n ?? limit)) as MessageRow[]
    let rows = page(cursor)
    // A page can start mid-turn (oldest rows are tool results whose assistant
    // turn is older). Extend backward to the turn start so tool rows always
    // fold into their assistant message instead of orphan wrappers.
    for (let guard = 0; rows.length > 0 && rows[rows.length - 1].role === "tool" && guard < 4; guard++) {
      const more = page(String(rows[rows.length - 1].id), 8)
      if (!more.length) break
      rows = rows.concat(more)
    }
    const data = mapMessages(rows, agent, model)
    // Cursor over *canvas* messages is awkward because tool rows fold into
    // assistant turns; page over raw row ids instead: next = oldest raw id.
    const next = rows.length >= limit && rows.length ? String(rows[rows.length - 1].id) : null
    return next ? { data, cursor: { next } } : { data }
  } finally {
    db.close()
  }
}

export function searchSessions(query: string, max = 200): CanvasSession[] {
  const db = openDb(true)
  try {
    const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    const rows = db.query(
      `SELECT ${SESSION_COLS} FROM sessions WHERE COALESCE(archived,0)=0 AND COALESCE(hidden,0)=0
       AND (title LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR COALESCE(cwd,'') LIKE ? ESCAPE '\\'
            OR COALESCE(git_repo_root,'') LIKE ? ESCAPE '\\' OR id IN (SELECT session_id FROM messages_fts WHERE messages_fts MATCH ? LIMIT 200))
       ORDER BY started_at DESC LIMIT ?`,
    ).all(like, like, like, like, query, max) as SessionRow[]
    const last = lastMsgMap(db)
    return rows.map((r) => mapSession(r, { lastMsgAt: last.get(r.id) }))
  } catch {
    // FTS5 MATCH can throw on query syntax; fall back to LIKE-only.
    const db2 = openDb(true)
    try {
      const like = `%${query}%`
      const rows = db2.query(
        `SELECT ${SESSION_COLS} FROM sessions WHERE COALESCE(archived,0)=0 AND COALESCE(hidden,0)=0
         AND (title LIKE ? OR id LIKE ? OR COALESCE(cwd,'') LIKE ? OR COALESCE(git_repo_root,'') LIKE ?)
         ORDER BY started_at DESC LIMIT ?`,
      ).all(like, like, like, like, max) as SessionRow[]
      const last = lastMsgMap(db2)
      return rows.map((r) => mapSession(r, { lastMsgAt: last.get(r.id) }))
    } finally {
      db2.close()
    }
  } finally {
    db.close()
  }
}

export function listModels(): Array<{ id: string; providerID: string; name: string }> {
  const seen = new Map<string, { id: string; providerID: string; name: string }>()
  // Models actually used, most recent first.
  try {
    const db = openDb(true)
    try {
      const rows = db.query(
        "SELECT model, billing_provider FROM sessions GROUP BY model ORDER BY MAX(started_at) DESC LIMIT 50",
      ).all() as Array<{ model: string | null; billing_provider: string | null }>
      for (const r of rows) {
        const m = parseModel(r.model, r.billing_provider)
        if (!seen.has(m.name)) seen.set(m.name, m)
      }
    } finally {
      db.close()
    }
  } catch { /* ignore */ }
  // Plus everything configured in config.yaml custom providers.
  for (const m of modelsFromConfig()) if (!seen.has(m.name)) seen.set(m.name, m)
  return [...seen.values()]
}

function modelsFromConfig(): Array<{ id: string; providerID: string; name: string }> {
  // Minimal YAML scan: inside `custom_providers:`, each `- name: <provider>`
  // starts a block whose `models:` map keys are model ids.
  const out: Array<{ id: string; providerID: string; name: string }> = []
  let cfg: string
  try {
    cfg = readFileSync(join(hermesHome(), "config.yaml"), "utf8")
  } catch {
    return out
  }
  let curProvider: string | undefined
  let inModels = false
  let inCustom = false
  for (const line of cfg.split("\n")) {
    if (/^custom_providers:/.test(line)) { inCustom = true; continue }
    if (inCustom && /^[A-Za-z]/.test(line)) break
    if (!inCustom) continue
    const pm = line.match(/^  - name:\s*(.+?)\s*$/)
    if (pm) { curProvider = pm[1]; inModels = false; continue }
    if (/^    models:\s*$/.test(line)) { inModels = true; continue }
    if (inModels && curProvider) {
      if (/^    \S/.test(line)) inModels = false
      else {
        const mm = line.match(/^      ([^:#\s][^:]*):/)
        if (mm) {
          const id = mm[1].trim()
          out.push({ id, providerID: curProvider, name: `${curProvider}/${id}` })
        }
      }
    }
  }
  return out
}

export function defaultModel(): { id: string; providerID: string; name: string } | undefined {
  try {
    const cfg = readFileSync(join(hermesHome(), "config.yaml"), "utf8")
    const m = cfg.match(/^  default:\s*(.+?)\s*$/m)
    if (m) {
      const raw = m[1]
      const slash = raw.indexOf("/")
      if (slash > 0) return { id: raw.slice(slash + 1), providerID: raw.slice(0, slash), name: raw }
      return { id: raw, providerID: "custom", name: raw }
    }
  } catch { /* ignore */ }
  return undefined
}

export function listFolders(path: string): string[] {
  const st = statSync(path)
  if (!st.isDirectory()) throw new Error("not a directory")
  return readdirSync(path)
    .map((n: string) => join(path, n).replace(/\/+$/, ""))
    .filter((p: string) => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    })
}

// ---------------------------------------------------------------------------
// Writes (CLI-first; SQL only where the CLI has no verb)
// ---------------------------------------------------------------------------

async function runCli(args: string[], opts?: { timeoutMs?: number; cwd?: string }): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([...hermesArgv(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: opts?.cwd,
    env: { ...process.env },
  })
  const timer = setTimeout(() => proc.kill(), opts?.timeoutMs ?? 30_000)
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  clearTimeout(timer)
  return { code: proc.exitCode ?? 1, out: out.trim(), err: err.trim() }
}

export async function renameSession(id: string, title: string): Promise<void> {
  const r = await runCli(["sessions", "rename", id, title])
  if (r.code !== 0) throw new Error(r.err || `rename failed (${r.code})`)
}

export function setSessionModel(id: string, model: string): void {
  const db = new Database(dbPath())
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    db.query("UPDATE sessions SET model = ? WHERE id = ?").run(model, id)
  } finally {
    db.close()
  }
}

export function createSessionRow(directory: string, model?: string, title?: string): CanvasSession {
  const rand = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const id =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${rand}`
  const started = Date.now() / 1000
  const db = new Database(dbPath())
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    db.query(
      `INSERT INTO sessions (id, source, model, title, cwd, started_at, message_count, tool_call_count,
        input_tokens, output_tokens, archived, created_source)
       VALUES (?, 'canvas', ?, ?, ?, ?, 0, 0, 0, 0, 0, 'canvas')`,
    ).run(id, model ?? "", title ?? "New canvas session", directory || null, started)
  } finally {
    db.close()
  }
  const s = getSession(id, new Map(), new Set())
  if (!s) throw new Error("session row was not created")
  return s
}

// ---------------------------------------------------------------------------
// Viewed markers (canvas sidecar; Hermes' own last_read_at belongs to Hermes)
// ---------------------------------------------------------------------------

function viewedPath(): string {
  return process.env.HERMES_CANVAS_VIEWED ?? join(hermesHome(), "canvas_viewed.json")
}

export function loadViewed(): Map<string, number> {
  try {
    const json = JSON.parse(readFileSync(viewedPath(), "utf8"))
    const m = new Map<string, number>()
    for (const [k, v] of Object.entries(json ?? {})) if (typeof v === "number") m.set(k, v)
    return m
  } catch {
    return new Map()
  }
}

export function saveViewed(m: Map<string, number>): void {
  try {
    mkdirSync(dirname(viewedPath()), { recursive: true })
    writeFileSync(viewedPath(), JSON.stringify(Object.fromEntries(m)))
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Live prompt processes (`hermes chat --resume … --format stream-json`)
// ---------------------------------------------------------------------------

export interface PromptHandle {
  sessionID: string
  proc: ReturnType<typeof Bun.spawn>
  assistantID: string
  startedAt: number
}

const runningProcs = new Map<string, PromptHandle>()
let autoApproveAll = false
const sessionYolo = new Set<string>()

export function runningSessionIDs(): Set<string> {
  return new Set(runningProcs.keys())
}

export function setAutoApproveAll(v: boolean): void {
  autoApproveAll = v
}

export function setSessionYolo(id: string, v: boolean): void {
  if (v) sessionYolo.add(id)
  else sessionYolo.delete(id)
}

export function sessionYoloState(id: string): boolean {
  return autoApproveAll || sessionYolo.has(id)
}

function winPath(p: string): string {
  // Hermes chat resolves cwd from PWD; MSYS-style /c/... paths break it.
  if (/^\/[a-z]\//i.test(p)) return `${p[1].toUpperCase()}:${p.slice(2).replace(/\//g, "\\")}`
  return p
}

export async function startPrompt(
  id: string,
  text: string,
  opts: { emit: (ev: CanvasEvent) => void; model?: string; cwd?: string },
): Promise<void> {
  if (runningProcs.has(id)) throw new Error("session is already running")
  const launcher = await resolveChatLauncher()
  const argv = [...launcher.argv, "chat", "--resume", id, "-q", text, "--format", "stream-json"]
  if (opts.model) argv.push("-m", opts.model)
  if (autoApproveAll || sessionYolo.has(id)) argv.push("--yolo")
  const cwd = opts.cwd ? winPath(opts.cwd) : winPath(hermesHome())
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: process.env.HERMES_CANVAS_PROMPT_CWD ?? cwd,
    env: { ...process.env, ...launcher.env, PWD: process.env.HERMES_CANVAS_PROMPT_CWD ?? cwd },
  })
  const aid = `live_${id}_${Date.now().toString(36)}`
  const handle: PromptHandle = { sessionID: id, proc, assistantID: aid, startedAt: Date.now() }
  runningProcs.set(id, handle)
  opts.emit({ id: uid("evt"), type: "session.execution.started", created: Date.now(), data: { sessionID: id } });
  void pumpPromptStream(handle, opts.emit).finally(() => {
    if (runningProcs.get(id) === handle) runningProcs.delete(id)
  })
}

async function pumpPromptStream(handle: PromptHandle, emit: (ev: CanvasEvent) => void): Promise<void> {
  const { sessionID: id, proc, assistantID: aid } = handle
  const now = () => Date.now()
  let sawText = false
  let toolSeq = 0
  const toolIDs = new Map<string, string>()
  const finish = (ok: boolean) => {
    if (sawText) emit({ id: uid("evt"), type: "session.text.ended", created: now(), data: { sessionID: id, assistantMessageID: aid } })
    emit({ id: uid("evt"), type: "session.step.ended", created: now(), data: { sessionID: id, assistantMessageID: aid } })
    emit({
      id: uid("evt"),
      type: ok ? "session.execution.succeeded" : "session.execution.failed",
      created: now(),
      data: { sessionID: id },
    })
  }
  try {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.type === "text" && typeof msg.text === "string" && msg.text) {
          if (!sawText) {
            sawText = true
            emit({ id: uid("evt"), type: "session.text.started", created: now(), data: { sessionID: id, assistantMessageID: aid, ordinal: 0 } })
          }
          emit({ id: uid("evt"), type: "session.text.delta", created: now(), data: { sessionID: id, assistantMessageID: aid, ordinal: 0, delta: msg.text } })
        } else if (msg.type === "tool_use") {
          const tid = String(msg.tool_call_id ?? `live_${toolSeq++}`)
          toolIDs.set(String(msg.tool_call_id ?? msg.name), tid)
          emit({ id: uid("evt"), type: "session.tool.input.started", created: now(), data: { sessionID: id, assistantMessageID: aid, id: tid, name: String(msg.name ?? "tool") } })
          emit({ id: uid("evt"), type: "session.tool.called", created: now(), data: { sessionID: id, assistantMessageID: aid, id: tid, input: msg.input, executed: true } })
        } else if (msg.type === "tool_result") {
          const tid = toolIDs.get(String(msg.tool_call_id ?? msg.name)) ?? String(msg.tool_call_id ?? `live_${toolSeq++}`)
          const out = String(msg.output ?? "")
          if (msg.is_error) {
            emit({ id: uid("evt"), type: "session.tool.failed", created: now(), data: { sessionID: id, assistantMessageID: aid, id: tid, error: out.slice(0, 2000) } })
          } else {
            emit({ id: uid("evt"), type: "session.tool.success", created: now(), data: { sessionID: id, assistantMessageID: aid, id: tid, content: [{ type: "text", text: capText(out) }], executed: true } })
          }
        } else if (msg.type === "result") {
          finish((msg.exit_code ?? 0) === 0 && !msg.error)
          // Drain stderr, wait for exit, stop reading stdout.
          try { reader.cancel() } catch { /* ignore */ }
          await proc.exited
          try {
            if (proc.stderr instanceof ReadableStream) await new Response(proc.stderr).text()
          } catch { /* ignore */ }
          return
        }
      }
    }
    await proc.exited;
    finish((proc.exitCode ?? 1) === 0)
  } catch {
    try { proc.kill() } catch { /* ignore */ }
    await proc.exited.catch(() => {})
    finish(false)
  }
}

export function interruptSession(id: string): boolean {
  const h = runningProcs.get(id)
  if (!h) return false
  try {
    h.proc.kill()
  } catch {
    return false
  }
  runningProcs.delete(id)
  return true
}

// ---------------------------------------------------------------------------
// Watcher: turn external DB changes (gateway/CLI sessions) into canvas events
// ---------------------------------------------------------------------------

export function startWatcher(emit: (ev: CanvasEvent) => void, intervalMs = 1000): () => void {
  let maxMsg = 0
  let sessions = new Map<string, string>()
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined
  const pendingExternal = new Map<string, ReturnType<typeof setTimeout>>()

  const snapshot = () => {
    const db = openDb(true)
    try {
      try {
        const row = db.query("SELECT MAX(id) m FROM messages").get() as { m: number | null } | null
        if (row && typeof row.m === "number") {
          if (maxMsg === 0) maxMsg = row.m
        }
      } catch { /* ignore */ }
      const next = new Map<string, string>()
      try {
        const rows = db.query("SELECT id, title, model, ended_at, end_reason FROM sessions").all() as Array<{
          id: string; title: string | null; model: string | null; ended_at: number | null; end_reason: string | null
        }>
        for (const r of rows) next.set(r.id, JSON.stringify([r.title, r.model, r.ended_at, r.end_reason]))
      } catch { /* ignore */ }
      if (sessions.size === 0) {
        sessions = next
        return
      }
      // New sessions.
      for (const [id, fp] of next) {
        if (!sessions.has(id)) {
          const full = getSession(id, loadViewed(), runningSessionIDs())
          void fp
          emit({
            id: uid("evt"),
            type: "session.created",
            created: Date.now(),
            data: full
              ? { sessionID: id, parentID: full.parentID, projectID: full.projectID, agent: full.agent, model: full.model, title: full.title, location: full.location }
              : { sessionID: id },
          })
        }
      }
      sessions = next
    } finally {
      db.close()
    }
  }

  const poll = () => {
    if (stopped) return
    let fresh: Array<{ session_id: string }> = []
    const db = openDb(true)
    try {
      try {
        fresh = db.query("SELECT DISTINCT session_id FROM messages WHERE id > ?").all(maxMsg) as typeof fresh
        const row = db.query("SELECT MAX(id) m FROM messages").get() as { m: number | null } | null
        if (row && typeof row.m === "number") maxMsg = Math.max(maxMsg, row.m)
      } catch { /* ignore */ }
    } finally {
      db.close()
    }
    for (const r of fresh) {
      const id = r.session_id
      if (runningProcs.has(id)) continue // streaming path owns this session
      if (!pendingExternal.has(id)) {
        emit({ id: uid("evt"), type: "session.execution.started", created: Date.now(), data: { sessionID: id } })
      } else {
        clearTimeout(pendingExternal.get(id)!)
      }
      pendingExternal.set(
        id,
        setTimeout(() => {
          pendingExternal.delete(id)
          emit({ id: uid("evt"), type: "session.execution.succeeded", created: Date.now(), data: { sessionID: id } })
        }, 4000),
      )
    }
    snapshot()
  }

  // Prime synchronously so the first poll only sees fresh changes.
  try {
    snapshot()
  } catch { /* DB may not exist yet in tests */ }
  timer = setInterval(poll, intervalMs)
  return () => {
    stopped = true
    if (timer) clearInterval(timer)
    for (const t of pendingExternal.values()) clearTimeout(t)
    pendingExternal.clear()
  }
}
