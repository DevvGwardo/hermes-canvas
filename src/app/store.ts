// Client-side model of every session, kept current from the event stream.

import type { Backend, ConnectionState } from "./backend"
import { basename, describeTool, lastAssistantText } from "./format"
import { previewBlocks } from "./markdown"
import type { FormInfo, Message, OcEvent, PermissionRequest, PermissionRule, Project, Session } from "./types"

/** The rule that allows everything in a session (Hermes maps it to `--yolo` on canvas-spawned prompts). */
export const ALLOW_ALL: PermissionRule = { action: "*", resource: "*", effect: "allow" }
const isAllowAll = (r: PermissionRule) => r.action === "*" && r.resource === "*" && r.effect === "allow"
const AUTO_KEY = "hermes-canvas.autoApprove"

export interface Preview {
  text: string
  bullets: string[]
  /** Last user message, shown when the agent hasn't answered it yet. */
  pendingUser?: string
}

export interface Group {
  key: string
  label: string
  directory: string
  sessions: Session[]
  updated: number
}

type Listener = {
  structure?: () => void
  cards?: (ids: Set<string>) => void
  event?: (ev: OcEvent) => void
  connection?: (s: ConnectionState) => void
}

const MAX_SESSIONS = 600
const PREVIEW_CONCURRENCY = 4
/** Finished sessions you haven't opened count as "to review" for this long. */
export const REVIEW_WINDOW = 48 * 3600_000

/**
 * One visual state per session, most urgent first:
 * needs-you > working > failed (unseen) > review > stopped > failed > done
 */
export type Status = "needs-you" | "working" | "review" | "failed" | "stopped" | "done"

export const STATUS_LABEL: Record<Status, string> = {
  "needs-you": "Needs you",
  working: "Working",
  review: "To review",
  failed: "Failed",
  stopped: "Stopped",
  done: "Done",
}

export class Store {
  sessions = new Map<string, Session>()
  projects = new Map<string, Project>()
  children = new Map<string, Set<string>>()
  running = new Set<string>()
  activity = new Map<string, string>()
  previews = new Map<string, Preview>()
  liveText = new Map<string, string>()
  permissions = new Map<string, PermissionRequest[]>()
  forms = new Map<string, FormInfo[]>()
  connection: ConnectionState = "connecting"
  loaded = false
  /** Approve every permission request from every session while the canvas is open. */
  autoApproveAll = (() => {
    try {
      return localStorage.getItem(AUTO_KEY) === "1"
    } catch {
      return false
    }
  })()
  /** Called after the canvas approves something on your behalf. */
  onAutoApproved?: (req: PermissionRequest) => void
  private approving = new Set<string>()

  private listeners = new Set<Listener>()
  private dirtyCards = new Set<string>()
  private structureDirty = false
  private flushScheduled = false
  private previewQueue: string[] = []
  private previewQueued = new Set<string>()
  private previewInflight = 0
  private previewStale = new Set<string>()
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private unsubscribe?: () => void
  private pollTimer?: ReturnType<typeof setInterval>

  constructor(public backend: Backend) {}

  on(l: Listener) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  // ---- loading ------------------------------------------------------------

  async start() {
    this.unsubscribe = this.backend.subscribe(
      (ev) => this.onEvent(ev),
      (s) => {
        const wasReconnecting = this.connection === "reconnecting"
        this.connection = this.backend.kind === "demo" ? "demo" : s
        for (const l of this.listeners) l.connection?.(this.connection)
        // Events were missed while disconnected: resync everything. A failed
        // resync is retried by refreshRecent/syncActive.
        if (s === "live" && wasReconnecting) this.reload().catch(() => {})
      },
    )
    await this.reload()
    this.pollTimer = setInterval(() => void this.syncActive(), 15_000)
    // Views from other clients (TUI, desktop) and any missed events.
    this.recentTimer = setInterval(() => void this.refreshRecent(), 45_000)
  }

  private recentTimer?: ReturnType<typeof setInterval>

  private async refreshRecent() {
    try {
      const recent = await this.backend.listSessions(100)
      let structure = false
      for (const fresh of recent) {
        const cur = this.sessions.get(fresh.id)
        if (!cur) {
          if (!fresh.time.archived) {
            this.sessions.set(fresh.id, fresh)
            structure = true
          }
          continue
        }
        if (fresh.time.archived) {
          this.sessions.delete(fresh.id)
          structure = true
          continue
        }
        const changed =
          cur.time.viewed !== fresh.time.viewed ||
          cur.time.idle !== fresh.time.idle ||
          cur.outcome !== fresh.outcome ||
          cur.title !== fresh.title
        if (changed) {
          if (cur.title !== fresh.title) structure = true
          this.sessions.set(fresh.id, { ...fresh, time: { ...fresh.time, viewed: Math.max(fresh.time.viewed ?? 0, cur.time.viewed ?? 0) || undefined } })
          this.touchParent(fresh.id)
        }
      }
      if (structure) {
        this.rebuildChildren()
        this.markStructure()
      }
    } catch {
      /* transient */
    }
  }

  stop() {
    this.unsubscribe?.()
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.recentTimer) clearInterval(this.recentTimer)
  }

  async reload() {
    const [projects, sessions, active] = await Promise.all([
      this.backend.listProjects().catch(() => [] as Project[]),
      this.backend.listSessions(MAX_SESSIONS),
      this.backend.active().catch(() => new Set<string>()),
    ])
    this.projects = new Map(projects.map((p) => [p.id, p]))
    this.sessions = new Map(sessions.filter((s) => !s.time.archived).map((s) => [s.id, s]))
    this.rebuildChildren()
    this.running = active
    // Asks answered elsewhere while we were disconnected would otherwise stay
    // pending here forever, so recheck those as well as running sessions.
    for (const id of new Set([...active, ...this.permissions.keys(), ...this.forms.keys()])) void this.syncAsks(id)
    this.previewStale = new Set(this.previews.keys())
    this.loaded = true
    this.markStructure()
  }

  addSessions(list: Session[]) {
    for (const s of list) this.sessions.set(s.id, s)
    this.rebuildChildren()
    this.markStructure()
  }

  private async syncActive() {
    try {
      const active = await this.backend.active()
      const changed = new Set<string>()
      for (const id of active) if (!this.running.has(id)) changed.add(id)
      for (const id of this.running) if (!active.has(id)) changed.add(id)
      if (!changed.size) return
      this.running = active
      for (const id of changed) {
        if (!active.has(id)) this.activity.delete(id)
        this.touchCard(id)
      }
    } catch {
      /* transient */
    }
  }

  private async syncAsks(id: string) {
    const [perms, forms] = await Promise.all([
      this.backend.permissions(id).catch(() => []),
      this.backend.forms(id).catch(() => []),
    ])
    this.setList(this.permissions, id, perms)
    this.setList(this.forms, id, forms)
    this.touchCard(id)
    for (const p of perms) this.maybeAutoApprove(p)
  }

  private setList<T>(map: Map<string, T[]>, id: string, list: T[]) {
    if (list.length) map.set(id, list)
    else map.delete(id)
  }

  private rebuildChildren() {
    this.children.clear()
    for (const s of this.sessions.values()) {
      if (!s.parentID) continue
      if (!this.children.has(s.parentID)) this.children.set(s.parentID, new Set())
      this.children.get(s.parentID)!.add(s.id)
    }
  }

  // ---- derived ------------------------------------------------------------

  roots(): Session[] {
    return [...this.sessions.values()].filter((s) => !s.parentID || !this.sessions.has(s.parentID))
  }

  groupKey(s: Session) {
    return s.projectID || s.location.directory
  }

  projectLabel(s: Session): string {
    const p = this.projects.get(s.projectID)
    return p?.name || basename(p?.canonical) || basename(s.location.directory) || "Sessions"
  }

  groups(): Group[] {
    const map = new Map<string, Group>()
    for (const s of this.roots()) {
      const key = this.groupKey(s)
      let g = map.get(key)
      if (!g) {
        g = { key, label: this.projectLabel(s), directory: s.location.directory, sessions: [], updated: 0 }
        map.set(key, g)
      }
      g.sessions.push(s)
      const t = this.isWorking(s.id) ? Date.now() : s.time.updated
      if (t > g.updated) {
        g.updated = t
        g.directory = s.location.directory
      }
    }
    // Things that want you float to the top of each project, then newest first.
    const now = Date.now()
    const rank = (id: string) => {
      const st = this.status(id, now)
      return st === "needs-you" ? 0 : st === "working" ? 1 : st === "review" || (st === "failed" && this.unseen(id)) ? 2 : 3
    }
    for (const g of map.values()) {
      const r = new Map(g.sessions.map((s) => [s.id, rank(s.id)]))
      g.sessions.sort((a, b) => r.get(a.id)! - r.get(b.id)! || b.time.updated - a.time.updated)
    }
    return [...map.values()].sort((a, b) => b.updated - a.updated)
  }

  subagentCount(id: string): number {
    return this.children.get(id)?.size ?? 0
  }

  isWorking(id: string): boolean {
    if (this.running.has(id)) return true
    for (const c of this.children.get(id) ?? []) if (this.running.has(c)) return true
    return false
  }

  needsInput(id: string): "permission" | "question" | undefined {
    if (this.permissions.get(id)?.length) return "permission"
    if (this.forms.get(id)?.length) return "question"
    for (const c of this.children.get(id) ?? []) {
      if (this.permissions.get(c)?.length) return "permission"
      if (this.forms.get(c)?.length) return "question"
    }
    return undefined
  }

  /** Short label for the card footer while the session works. */
  activityLabel(id: string): string {
    const own = this.activity.get(id)
    if (own && this.running.has(id)) return own
    for (const c of this.children.get(id) ?? []) {
      const a = this.activity.get(c)
      if (a && this.running.has(c)) return a
    }
    return own ?? "Working…"
  }

  /** Finished, and not looked at since it finished. */
  unseen(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s || !s.time.idle) return false
    return (s.time.viewed ?? 0) < s.time.idle
  }

  status(id: string, now = Date.now()): Status {
    const s = this.sessions.get(id)
    if (!s) return "done"
    if (this.needsInput(id)) return "needs-you"
    if (this.isWorking(id)) return "working"
    const fresh = this.unseen(id) && now - (s.time.idle ?? 0) < REVIEW_WINDOW
    if (s.outcome === "failed") return "failed"
    if (fresh && s.outcome !== "interrupted") return "review"
    if (s.outcome === "interrupted") return "stopped"
    return "done"
  }

  /** Root sessions by status, for the top bar and tab title. */
  statusCounts(now = Date.now()): Record<Status, number> {
    const counts: Record<Status, number> = { "needs-you": 0, working: 0, review: 0, failed: 0, stopped: 0, done: 0 }
    for (const s of this.roots()) {
      const st = this.status(s.id, now)
      // Old failures you've already seen aren't news.
      if (st === "failed" && !(this.unseen(s.id) && now - (s.time.idle ?? 0) < REVIEW_WINDOW)) counts.done++
      else counts[st]++
    }
    return counts
  }

  /** Statuses that count toward a filter chip (failed-and-unseen counts as review). */
  inFilter(id: string, filter: Status, now = Date.now()): boolean {
    const st = this.status(id, now)
    if (filter === "review") {
      const s = this.sessions.get(id)
      return st === "review" || (st === "failed" && this.unseen(id) && now - (s?.time.idle ?? 0) < REVIEW_WINDOW)
    }
    return st === filter
  }

  // ---- permissions -----------------------------------------------------------

  /** This session (or its parent) carries the allow-everything rule. */
  sessionAutoApproves(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    if (s.permissions?.some(isAllowAll)) return true
    const parent = s.parentID ? this.sessions.get(s.parentID) : undefined
    return !!parent?.permissions?.some(isAllowAll)
  }

  pendingPermissionCount(): number {
    let n = 0
    for (const list of this.permissions.values()) n += list.length
    return n
  }

  /** Reply "once" (no lasting rule) and drop it from the pending list. */
  async approve(req: PermissionRequest, auto = false) {
    if (this.approving.has(req.id)) return
    this.approving.add(req.id)
    try {
      await this.backend.replyPermission(req.sessionID, req.id, "once")
      this.setList(this.permissions, req.sessionID, (this.permissions.get(req.sessionID) ?? []).filter((p) => p.id !== req.id))
      this.touchParent(req.sessionID)
      if (auto) this.onAutoApproved?.(req)
    } finally {
      this.approving.delete(req.id)
    }
  }

  async approveAllPending(sessionID?: string): Promise<number> {
    const reqs = sessionID ? [...(this.permissions.get(sessionID) ?? [])] : [...this.permissions.values()].flat()
    const results = await Promise.allSettled(reqs.map((r) => this.approve(r)))
    return results.filter((r) => r.status === "fulfilled").length
  }

  setAutoApproveAll(on: boolean) {
    this.autoApproveAll = on
    try {
      localStorage.setItem(AUTO_KEY, on ? "1" : "0")
    } catch {
      /* private mode */
    }
    if (on) void this.approveAllPending()
    for (const id of this.permissions.keys()) this.touchParent(id)
  }

  /** Add or remove the allow-everything rule on the server for one session. */
  async setSessionAutoApprove(id: string, on: boolean) {
    const s = this.sessions.get(id)
    if (!s) return
    const rest = (s.permissions ?? []).filter((r) => !isAllowAll(r))
    const rules = on ? [...rest, ALLOW_ALL] : rest
    await this.backend.setSessionPermissions(id, rules.length ? rules : null)
    s.permissions = rules.length ? rules : null
    this.touchParent(id)
    if (on) await this.approveAllPending(id)
  }

  private maybeAutoApprove(req: PermissionRequest) {
    if (this.autoApproveAll || this.sessionAutoApproves(req.sessionID)) void this.approve(req, true).catch(() => {})
  }

  /** Record that you've seen this session's latest result (canvas sidecar, syncs to other clients). */
  markViewed(id: string) {
    const s = this.sessions.get(id)
    if (!s || !this.unseen(id)) return
    // The server stores exactly what we send; "now" always covers the finish.
    const at = Math.max(s.time.idle!, Date.now())
    s.time.viewed = at
    this.touchParent(id)
    this.backend.markViewed(id, at).catch(() => {})
  }

  title(s: Session): string {
    return s.title?.trim() || this.previews.get(s.id)?.pendingUser?.slice(0, 80) || "New session"
  }

  // ---- previews -----------------------------------------------------------

  /** Ask for a card's preview; cheap to call every frame for visible cards. */
  wantPreview(id: string) {
    if (this.previews.has(id) && !this.previewStale.has(id)) return
    if (this.previewQueued.has(id)) return
    this.previewQueued.add(id)
    this.previewQueue.push(id)
    this.pumpPreviews()
  }

  private pumpPreviews() {
    while (this.previewInflight < PREVIEW_CONCURRENCY && this.previewQueue.length) {
      // Newest requests first: those are the cards on screen right now.
      const id = this.previewQueue.pop()!
      this.previewInflight++
      this.loadPreview(id).finally(() => {
        this.previewInflight--
        this.previewQueued.delete(id)
        this.pumpPreviews()
      })
    }
  }

  private async loadPreview(id: string) {
    try {
      const page = await this.backend.messages(id, 16)
      this.previewStale.delete(id)
      this.previews.set(id, buildPreview(page.data))
      this.touchCard(id)
    } catch {
      if (!this.previews.has(id)) this.previews.set(id, { text: "", bullets: [] })
    }
  }

  private refreshPreviewSoon(id: string, delay = 900) {
    if (this.refreshTimers.has(id)) return
    this.refreshTimers.set(
      id,
      setTimeout(() => {
        this.refreshTimers.delete(id)
        this.previewStale.add(id)
        this.wantPreview(id)
      }, delay),
    )
  }

  // ---- events -------------------------------------------------------------

  private onEvent(ev: OcEvent) {
    const d = ev.data ?? {}
    const id: string | undefined = d.sessionID
    switch (ev.type) {
      case "session.created": {
        // Draft → real handoff: the first prompt on a draft mints a Hermes
        // session; drop the draft card when its real twin arrives.
        if (d.draftId && d.sessionID && d.draftId !== d.sessionID) {
          this.sessions.delete(d.draftId)
          this.running.delete(d.draftId)
        }
        const s: Session = {
          id: d.sessionID,
          parentID: d.parentID,
          projectID: d.projectID,
          agent: d.agent,
          model: d.model,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: ev.created ?? Date.now(), updated: ev.created ?? Date.now() },
          title: d.title,
          location: d.location ?? ev.location ?? { directory: "" },
        }
        this.sessions.set(s.id, s)
        if (s.parentID) {
          if (!this.children.has(s.parentID)) this.children.set(s.parentID, new Set())
          this.children.get(s.parentID)!.add(s.id)
          this.touchCard(s.parentID)
        }
        // The event lacks some fields (parentID on forks); fetch the real record.
        this.backend
          .getSession(s.id)
          .then((full) => {
            if (!this.sessions.has(s.id)) return
            this.sessions.set(s.id, full)
            this.rebuildChildren()
            this.markStructure()
          })
          .catch(() => {})
        this.markStructure()
        break
      }
      case "session.deleted":
        if (id && this.sessions.delete(id)) {
          this.rebuildChildren()
          this.markStructure()
        }
        break
      case "session.renamed":
        this.patch(id, (s) => (s.title = d.title), true)
        break
      case "session.moved":
      case "session.forked":
        if (id)
          this.backend
            .getSession(id)
            .then((s) => {
              this.sessions.set(id, s)
              this.markStructure()
            })
            .catch(() => {})
        break
      case "session.execution.started":
        if (!id) break
        this.running.add(id)
        this.activity.set(id, "Working…")
        this.liveText.delete(id)
        this.patch(id, (s) => {
          s.time.updated = ev.created ?? Date.now()
          delete s.outcome
        }, false)
        this.markStructure()
        break
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        if (!id) break
        this.running.delete(id)
        this.activity.delete(id)
        this.patch(
          id,
          (s) => {
            s.outcome = ev.type.endsWith("succeeded") ? "succeeded" : ev.type.endsWith("failed") ? "failed" : "interrupted"
            s.time.updated = ev.created ?? Date.now()
            s.time.idle = ev.created ?? Date.now()
          },
          false,
        )
        this.refreshPreviewSoon(id, 250)
        break
      case "session.reasoning.started":
        this.setActivity(id, "Thinking…")
        break
      case "session.reasoning.ended":
        this.setActivity(id, "Working…")
        break
      case "session.reasoning.delta":
        this.setActivity(id, "Thinking…")
        break
      case "session.text.started":
        this.setActivity(id, "Writing…")
        if (id) this.liveText.set(id, "")
        break
      case "session.text.delta":
        if (!id) break
        this.liveText.set(id, ((this.liveText.get(id) ?? "") + (d.delta ?? "")).slice(-600))
        this.touchCard(id)
        break
      case "session.text.ended":
        if (id) this.refreshPreviewSoon(id, 300)
        break
      case "session.tool.input.started":
        this.setActivity(id, describeTool(d.name ?? "tool"))
        if (id) this.toolNames.set(d.id, d.name)
        break
      case "session.tool.called":
        this.setActivity(id, describeTool(this.toolNames.get(d.id) ?? "tool", d.input))
        break
      case "session.tool.success":
      case "session.tool.failed":
        this.toolNames.delete(d.id)
        this.setActivity(id, "Working…")
        break
      case "session.compaction.started":
        this.setActivity(id, "Compacting context…")
        break
      case "session.retry.scheduled":
        this.setActivity(id, "Retrying…")
        break
      case "session.inbox.enqueued":
        if (id && d.item?.type === "user") {
          const p = this.previews.get(id)
          this.previews.set(id, { ...(p ?? { text: "", bullets: [] }), pendingUser: d.item.payload?.text })
          this.touchCard(id)
        }
        break
      case "session.model.selected":
        this.patch(id, (s) => (s.model = d.model ?? s.model), false)
        break
      case "session.usage.updated":
        this.patch(
          id,
          (s) => {
            s.cost = d.cost ?? s.cost
            s.tokens = d.tokens ?? s.tokens
          },
          false,
        )
        break
      case "permission.asked":
        if (id) {
          const list = (this.permissions.get(id) ?? []).filter((p) => p.id !== d.id)
          list.push(d as PermissionRequest)
          this.permissions.set(id, list)
          this.touchParent(id)
          this.maybeAutoApprove(d as PermissionRequest)
        }
        break
      case "permission.replied":
        if (id) {
          this.setList(
            this.permissions,
            id,
            (this.permissions.get(id) ?? []).filter((p) => p.id !== (d.requestID ?? d.id)),
          )
          // Payloads differ by version; confirm against the server.
          void this.syncAsks(id)
          this.touchParent(id)
        }
        break
      case "form.created":
      case "question.asked":
      case "form.replied":
      case "form.cancelled":
      case "question.replied":
      case "question.rejected":
        if (id) {
          void this.syncAsks(id)
          this.touchParent(id)
        }
        break
    }
    for (const l of this.listeners) l.event?.(ev)
  }

  private toolNames = new Map<string, string>()

  private setActivity(id: string | undefined, label: string) {
    if (!id) return
    // Do not resurrect a finished session from a late activity event:
    // once execution has landed (outcome set) and the turn is no longer
    // marked running, ignore stray deltas.
    const s = this.sessions.get(id)
    if (!this.running.has(id) && s?.outcome) return
    if (!this.running.has(id)) this.running.add(id)
    if (this.activity.get(id) === label) return
    this.activity.set(id, label)
    this.touchParent(id)
  }

  private touchParent(id: string) {
    this.touchCard(id)
    const parent = this.sessions.get(id)?.parentID
    if (parent) this.touchCard(parent)
  }

  private patch(id: string | undefined, fn: (s: Session) => void, structural: boolean) {
    if (!id) return
    const s = this.sessions.get(id)
    if (!s) return
    fn(s)
    if (structural) this.markStructure()
    this.touchParent(id)
  }

  // ---- change batching ----------------------------------------------------

  touchCard(id: string) {
    this.dirtyCards.add(id)
    this.scheduleFlush()
  }

  markStructure() {
    this.structureDirty = true
    this.scheduleFlush()
  }

  private scheduleFlush() {
    if (this.flushScheduled) return
    this.flushScheduled = true
    // Next frame when visible; the timer covers background tabs, where frames
    // don't run but the tab title and counts must keep updating.
    const run = () => {
      if (!this.flushScheduled) return
      this.flushScheduled = false
      if (this.structureDirty) {
        this.structureDirty = false
        for (const l of this.listeners) l.structure?.()
      }
      if (this.dirtyCards.size) {
        const ids = this.dirtyCards
        this.dirtyCards = new Set()
        for (const l of this.listeners) l.cards?.(ids)
      }
    }
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run)
    setTimeout(run, 300)
  }
}

export function buildPreview(desc: Message[]): Preview {
  // desc = newest first
  let pendingUser: string | undefined
  let answered = false
  for (const m of desc) {
    if (m.type === "assistant") {
      answered = true
      const text = lastAssistantText(m.content)
      if (text) return { ...previewBlocks(text), pendingUser }
    } else if (m.type === "user" && !answered && pendingUser === undefined) {
      pendingUser = m.text
    }
  }
  return { text: "", bullets: [], pendingUser }
}
