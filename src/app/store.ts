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
  autoApprove?: (on: boolean) => void
}

type AutoApproveCapable = Backend & { setAutoApproveAll?: (on: boolean) => Promise<void> }
type FieldKey = "title" | "model" | "usage" | "outcome" | "permissions" | "updated"

function sameModel(a?: Session["model"], b?: Session["model"]): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.providerID === b.providerID && a.id === b.id && a.variant === b.variant
}

function samePermissions(a?: PermissionRule[] | null, b?: PermissionRule[] | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((r, i) => {
    const o = b[i]
    return !!o && r.action === o.action && r.resource === o.resource && r.effect === o.effect
  })
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
  private flushRaf?: number
  private flushTimer?: ReturnType<typeof setTimeout>
  private started = false
  private startEpoch = 0
  private stopSeq = 0
  private reloadSeq = 0
  private activeClock = 0
  private sessionActiveSeq = new Map<string, number>()
  private askClock = 0
  private permAskSeq = new Map<string, number>()
  private formAskSeq = new Map<string, number>()
  private fieldClock = 0
  private fieldSeq = new Map<string, Map<FieldKey, number>>()
  private deleted = new Set<string>()
  private deleteSeq = new Map<string, number>()
  private previewQueue: string[] = []
  private previewQueued = new Set<string>()
  private previewInflight = 0
  private previewStale = new Set<string>()
  private previewVersion = new Map<string, number>()
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private sessionTools = new Map<string, Set<string>>()
  private unsubscribe?: () => void
  private pollTimer?: ReturnType<typeof setInterval>
  private recentTimer?: ReturnType<typeof setInterval>

  constructor(public backend: Backend) {}

  on(l: Listener) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private safeCall(fn: () => void) {
    try {
      fn()
    } catch {
      /* keep other listeners running */
    }
  }

  private syncBackendAutoApprove(on: boolean) {
    const b = this.backend as AutoApproveCapable
    if (typeof b.setAutoApproveAll === "function") {
      void Promise.resolve(b.setAutoApproveAll(on)).catch(() => {})
    }
  }

  // ---- loading ------------------------------------------------------------

  async start() {
    this.stop()
    this.started = true
    const epoch = ++this.startEpoch
    this.unsubscribe = this.backend.subscribe(
      (ev) => this.onEvent(ev),
      (s) => {
        const wasReconnecting = this.connection === "reconnecting"
        this.connection = this.backend.kind === "demo" ? "demo" : s
        for (const l of this.listeners) this.safeCall(() => l.connection?.(this.connection))
        // Events were missed while disconnected: resync everything. A failed
        // resync is retried by refreshRecent/syncActive.
        if (s === "live" && wasReconnecting) this.reload().catch(() => {})
      },
    )
    if (this.autoApproveAll) this.syncBackendAutoApprove(true)
    await this.reload(false)
    if (!this.started || epoch !== this.startEpoch) return
    this.pollTimer = setInterval(() => void this.syncActive(), 15_000)
    // Views from other clients (TUI, desktop) and any missed events.
    this.recentTimer = setInterval(() => void this.refreshRecent(), 45_000)
  }

  private async refreshRecent() {
    const seq = this.reloadSeq
    try {
      const recent = await this.backend.listSessions(100)
      if (seq !== this.reloadSeq) return
      let structure = false
      for (const fresh of recent) {
        const cur = this.sessions.get(fresh.id)
        if (!cur) {
          if (!fresh.time?.archived) {
            this.deleted.delete(fresh.id)
            this.sessions.set(fresh.id, fresh)
            structure = true
          }
          continue
        }
        if (fresh.time?.archived) {
          this.cleanupSession(fresh.id)
          structure = true
          continue
        }
        const permissions = fresh.permissions === undefined ? cur.permissions : fresh.permissions
        const keepOutcome =
          (cur.outcome === "failed" || cur.outcome === "interrupted") &&
          fresh.time.idle === cur.time.idle &&
          (fresh.outcome === undefined || fresh.outcome === "succeeded")
        const outcome = keepOutcome ? cur.outcome : fresh.outcome
        const viewed = Math.max(fresh.time.viewed ?? 0, cur.time.viewed ?? 0) || undefined
        const changed =
          viewed !== cur.time.viewed ||
          fresh.time.idle !== cur.time.idle ||
          fresh.time.updated !== cur.time.updated ||
          outcome !== cur.outcome ||
          cur.title !== fresh.title ||
          cur.parentID !== fresh.parentID ||
          cur.projectID !== fresh.projectID ||
          cur.cost !== fresh.cost ||
          !sameModel(cur.model, fresh.model) ||
          !samePermissions(cur.permissions, permissions)
        if (changed) {
          if (cur.title !== fresh.title || cur.parentID !== fresh.parentID || cur.projectID !== fresh.projectID) {
            structure = true
          }
          const previewAdvanced = (fresh.time.idle ?? 0) > (cur.time.idle ?? 0) || fresh.time.updated > cur.time.updated
          this.sessions.set(fresh.id, {
            ...fresh,
            location: fresh.location ?? cur.location ?? { directory: "" },
            outcome,
            permissions,
            time: { ...fresh.time, viewed },
          })
          if (previewAdvanced && this.previews.has(fresh.id)) {
            this.previewStale.add(fresh.id)
            this.bumpPreviewVersion(fresh.id)
          }
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

  private clearFlushTimers() {
    if (this.flushRaf !== undefined) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.flushRaf)
      this.flushRaf = undefined
    }
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
  }

  stop() {
    this.started = false
    this.startEpoch++
    this.stopSeq++
    this.reloadSeq++
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    if (this.recentTimer !== undefined) {
      clearInterval(this.recentTimer)
      this.recentTimer = undefined
    }
    for (const t of this.refreshTimers.values()) clearTimeout(t)
    this.refreshTimers.clear()
    this.clearFlushTimers()
    this.flushScheduled = false
    this.previewQueue.length = 0
    this.previewQueued.clear()
  }

  async reload(syncAuto = true) {
    const seq = ++this.reloadSeq
    const activeT0 = this.activeClock
    const [projects, sessions, active] = await Promise.all([
      this.backend.listProjects().catch(() => [] as Project[]),
      this.backend.listSessions(MAX_SESSIONS),
      this.backend.active().catch(() => new Set<string>()),
    ])
    if (seq !== this.reloadSeq) return
    const prev = this.sessions
    this.projects = new Map(projects.map((p) => [p.id, p]))
    const nextSessions = new Map<string, Session>()
    for (const fresh of sessions) {
      if (fresh.time?.archived) continue
      this.deleted.delete(fresh.id)
      const cur = prev.get(fresh.id)
      if (!cur) {
        nextSessions.set(fresh.id, fresh)
        continue
      }
      const permissions = fresh.permissions === undefined ? cur.permissions : fresh.permissions
      const keepOutcome =
        (cur.outcome === "failed" || cur.outcome === "interrupted") &&
        fresh.time.idle === cur.time.idle &&
        (fresh.outcome === undefined || fresh.outcome === "succeeded")
      const outcome = keepOutcome ? cur.outcome : fresh.outcome
      const viewed = Math.max(fresh.time.viewed ?? 0, cur.time.viewed ?? 0) || undefined
      nextSessions.set(fresh.id, {
        ...fresh,
        location: fresh.location ?? cur.location ?? { directory: "" },
        outcome,
        permissions,
        time: { ...fresh.time, viewed },
      })
    }
    for (const id of prev.keys()) {
      if (!nextSessions.has(id)) this.cleanupSession(id, false)
    }
    this.sessions = nextSessions
    this.rebuildChildren()
    const nextRunning = new Set(active)
    for (const [id, evSeq] of this.sessionActiveSeq) {
      if (evSeq <= activeT0) continue
      if (this.running.has(id)) nextRunning.add(id)
      else nextRunning.delete(id)
    }
    this.running = nextRunning
    for (const id of this.activity.keys()) if (!this.running.has(id)) this.activity.delete(id)
    for (const id of this.liveText.keys()) if (!this.running.has(id)) this.liveText.delete(id)
    for (const id of this.sessionTools.keys()) if (!this.running.has(id)) this.clearSessionTools(id)
    if (syncAuto && this.autoApproveAll) this.syncBackendAutoApprove(true)
    // Asks answered elsewhere while we were disconnected would otherwise stay
    // pending here forever, so recheck those as well as running sessions.
    for (const id of new Set([...this.running, ...this.permissions.keys(), ...this.forms.keys()])) void this.syncAsks(id)
    this.previewStale = new Set(this.previews.keys())
    for (const id of this.previewStale) this.bumpPreviewVersion(id)
    this.loaded = true
    this.markStructure()
  }

  addSessions(list: Session[]) {
    for (const s of list) {
      if (s.time?.archived) continue
      this.deleted.delete(s.id)
      this.sessions.set(s.id, s)
    }
    this.rebuildChildren()
    this.markStructure()
  }

  private async syncActive() {
    const t0 = this.activeClock
    const rel = this.reloadSeq
    try {
      const active = await this.backend.active()
      if (rel !== this.reloadSeq) return
      const next = new Set(this.running)
      const changed = new Set<string>()
      for (const id of active) {
        if (this.running.has(id) || this.deleted.has(id)) continue
        if ((this.sessionActiveSeq.get(id) ?? 0) > t0) continue
        next.add(id)
        changed.add(id)
      }
      for (const id of this.running) {
        if (active.has(id)) continue
        if ((this.sessionActiveSeq.get(id) ?? 0) > t0) continue
        next.delete(id)
        changed.add(id)
      }
      if (!changed.size) return
      this.running = next
      for (const id of changed) {
        if (!next.has(id)) {
          this.activity.delete(id)
          this.liveText.delete(id)
          this.clearSessionTools(id)
          if (this.sessions.has(id)) this.refreshPreviewSoon(id, 250)
        }
        this.touchParent(id)
      }
    } catch {
      /* transient */
    }
  }

  private bumpAskSeq(id: string, kind: "perm" | "form" | "both") {
    const seq = ++this.askClock
    if (kind === "perm" || kind === "both") this.permAskSeq.set(id, seq)
    if (kind === "form" || kind === "both") this.formAskSeq.set(id, seq)
  }

  private async syncAsks(id: string) {
    const pSeq = this.permAskSeq.get(id) ?? 0
    const fSeq = this.formAskSeq.get(id) ?? 0
    const rel = this.reloadSeq
    const del = this.deleteSeq.get(id) ?? 0
    const [perms, forms] = await Promise.all([
      this.backend.permissions(id).catch(() => []),
      this.backend.forms(id).catch(() => []),
    ])
    if (this.reloadSeq !== rel || (this.deleteSeq.get(id) ?? 0) !== del || this.deleted.has(id)) return
    const permCurrent = (this.permAskSeq.get(id) ?? 0) === pSeq
    const formCurrent = (this.formAskSeq.get(id) ?? 0) === fSeq
    if (permCurrent) this.setList(this.permissions, id, perms)
    if (formCurrent) this.setList(this.forms, id, forms)
    if (permCurrent || formCurrent) this.touchParent(id)
    if (permCurrent) for (const p of perms) this.maybeAutoApprove(p)
  }

  private setList<T>(map: Map<string, T[]>, id: string, list: T[]) {
    if (list.length) map.set(id, list)
    else map.delete(id)
  }

  private rebuildChildren() {
    this.children.clear()
    for (const s of this.sessions.values()) {
      if (!s.parentID || s.parentID === s.id) continue
      if (!this.children.has(s.parentID)) this.children.set(s.parentID, new Set())
      this.children.get(s.parentID)!.add(s.id)
    }
  }

  // ---- derived ------------------------------------------------------------

  roots(): Session[] {
    const res: Session[] = []
    const brokenCycles = new Set<string>()
    for (const s of this.sessions.values()) {
      if (!s.parentID || s.parentID === s.id || !this.sessions.has(s.parentID)) {
        res.push(s)
        continue
      }
      const seen = new Set<string>([s.id])
      let cur: Session | undefined = this.sessions.get(s.parentID)
      while (cur && cur.parentID && cur.parentID !== cur.id && this.sessions.has(cur.parentID) && !seen.has(cur.id)) {
        seen.add(cur.id)
        cur = this.sessions.get(cur.parentID)
      }
      if (cur && seen.has(cur.id)) {
        // Pick deterministic representative from the cycle itself (min ID).
        const cycle = [cur.id]
        let step = this.sessions.get(cur.parentID!)
        while (step && step.id !== cur.id) {
          cycle.push(step.id)
          step = step.parentID ? this.sessions.get(step.parentID) : undefined
        }
        cycle.sort()
        const rep = cycle[0]!
        if (s.id === rep && !brokenCycles.has(rep)) {
          brokenCycles.add(rep)
          res.push(s)
        }
      }
    }
    return res
  }

  groupKey(s: Session) {
    return s.projectID || s.location?.directory || ""
  }

  projectLabel(s: Session): string {
    const p = this.projects.get(s.projectID)
    return p?.name || basename(p?.canonical) || basename(s.location?.directory) || "Sessions"
  }

  groups(): Group[] {
    const now = Date.now()
    const map = new Map<string, Group>()
    const dirTimes = new Map<string, number>()
    for (const s of this.roots()) {
      const dir = s.location?.directory ?? ""
      const key = this.groupKey(s)
      let g = map.get(key)
      if (!g) {
        g = { key, label: this.projectLabel(s), directory: dir, sessions: [], updated: -1 }
        map.set(key, g)
        dirTimes.set(key, -1)
      }
      g.sessions.push(s)
      const t = this.isWorking(s.id) ? now : s.time.updated
      const prevDirT = dirTimes.get(key) ?? -1
      if (t > g.updated || (t === g.updated && s.time.updated > prevDirT)) {
        g.updated = t
        dirTimes.set(key, s.time.updated)
        g.directory = dir
      }
    }
    // Things that want you float to the top of each project, then newest first.
    const rank = (id: string) => {
      const st = this.status(id, now)
      if (st === "needs-you") return 0
      if (st === "working") return 1
      const s = this.sessions.get(id)
      const freshFail = st === "failed" && this.unseen(id) && now - (s?.time.idle ?? 0) < REVIEW_WINDOW
      if (st === "review" || freshFail) return 2
      return 3
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

  private collectPermissions(sessionID: string, includeSubagents: boolean): PermissionRequest[] {
    if (!includeSubagents) return [...(this.permissions.get(sessionID) ?? [])]
    const out: PermissionRequest[] = []
    const seen = new Set<string>()
    const queue = [sessionID]
    while (queue.length) {
      const cur = queue.shift()!
      if (seen.has(cur)) continue
      seen.add(cur)
      out.push(...(this.permissions.get(cur) ?? []))
      for (const child of this.children.get(cur) ?? []) queue.push(child)
    }
    return out
  }

  /** Reply "once" (no lasting rule) and drop it from the pending list. */
  async approve(req: PermissionRequest, auto = false): Promise<boolean> {
    if (this.approving.has(req.id)) return false
    this.approving.add(req.id)
    try {
      await this.backend.replyPermission(req.sessionID, req.id, "once")
      this.bumpAskSeq(req.sessionID, "perm")
      this.setList(this.permissions, req.sessionID, (this.permissions.get(req.sessionID) ?? []).filter((p) => p.id !== req.id))
      this.touchParent(req.sessionID)
      if (auto) this.onAutoApproved?.(req)
      return true
    } finally {
      this.approving.delete(req.id)
    }
  }

  async approveAllPending(sessionID?: string, includeSubagents = false): Promise<number> {
    const reqs = sessionID ? this.collectPermissions(sessionID, includeSubagents) : [...this.permissions.values()].flat()
    const results = await Promise.allSettled(reqs.map((r) => this.approve(r)))
    return results.filter((r) => r.status === "fulfilled" && r.value).length
  }

  setAutoApproveAll(on: boolean) {
    this.autoApproveAll = on
    try {
      localStorage.setItem(AUTO_KEY, on ? "1" : "0")
    } catch {
      /* private mode */
    }
    this.syncBackendAutoApprove(on)
    if (on) void this.approveAllPending()
    for (const id of this.permissions.keys()) this.touchParent(id)
    for (const l of this.listeners) this.safeCall(() => l.autoApprove?.(on))
  }

  /** Add or remove the allow-everything rule on the server for one session. */
  async setSessionAutoApprove(id: string, on: boolean) {
    const s = this.sessions.get(id)
    if (!s) return
    const rest = (s.permissions ?? []).filter((r) => !isAllowAll(r))
    const next = on ? [...rest, ALLOW_ALL] : rest
    const rules = next.length ? next : null
    await this.backend.setSessionPermissions(id, rules)
    const cur = this.sessions.get(id)
    if (cur) {
      cur.permissions = rules
      this.bumpField(id, "permissions")
      this.touchParent(id)
    }
    if (on) await this.approveAllPending(id, true)
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

  private bumpPreviewVersion(id: string) {
    this.previewVersion.set(id, (this.previewVersion.get(id) ?? 0) + 1)
  }

  /** Ask for a card's preview; cheap to call every frame for visible cards. */
  wantPreview(id: string) {
    if (this.deleted.has(id)) return
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
      this.loadPreview(id).then((invalidated) => {
        this.previewInflight--
        this.previewQueued.delete(id)
        if (invalidated && !this.deleted.has(id) && this.previewStale.has(id)) {
          this.wantPreview(id)
        } else {
          this.pumpPreviews()
        }
      })
    }
  }

  private async loadPreview(id: string): Promise<boolean> {
    const ver = this.previewVersion.get(id) ?? 0
    const stoppedAt = this.stopSeq
    try {
      const page = await this.backend.messages(id, 16)
      if (this.stopSeq !== stoppedAt || this.deleted.has(id)) return false
      const currentVer = this.previewVersion.get(id) ?? 0
      if (currentVer === ver) this.previewStale.delete(id)
      this.previews.set(id, buildPreview(page.data))
      this.touchCard(id)
      return currentVer !== ver
    } catch {
      if (this.stopSeq === stoppedAt && !this.deleted.has(id) && !this.previews.has(id)) {
        this.previews.set(id, { text: "", bullets: [] })
      }
      return false
    }
  }

  private refreshPreviewSoon(id: string, delay = 900) {
    if (this.deleted.has(id) || this.refreshTimers.has(id)) return
    this.refreshTimers.set(
      id,
      setTimeout(() => {
        this.refreshTimers.delete(id)
        if (this.deleted.has(id)) return
        this.previewStale.add(id)
        this.bumpPreviewVersion(id)
        this.wantPreview(id)
      }, delay),
    )
  }

  // ---- events -------------------------------------------------------------

  private cleanupSession(id: string, recordDeleted = true) {
    if (recordDeleted) {
      this.deleted.add(id)
      this.deleteSeq.set(id, (this.deleteSeq.get(id) ?? 0) + 1)
    }
    this.sessions.delete(id)
    this.running.delete(id)
    this.activity.delete(id)
    this.liveText.delete(id)
    this.previews.delete(id)
    this.previewStale.delete(id)
    this.previewVersion.delete(id)
    this.permissions.delete(id)
    this.forms.delete(id)
    this.fieldSeq.delete(id)
    this.sessionActiveSeq.delete(id)
    this.permAskSeq.delete(id)
    this.formAskSeq.delete(id)
    this.clearSessionTools(id)
    const t = this.refreshTimers.get(id)
    if (t !== undefined) {
      clearTimeout(t)
      this.refreshTimers.delete(id)
    }
  }

  private bumpField(id: string, field: FieldKey) {
    let m = this.fieldSeq.get(id)
    if (!m) {
      m = new Map()
      this.fieldSeq.set(id, m)
    }
    m.set(field, ++this.fieldClock)
  }

  private fieldSnap(id: string): Map<FieldKey, number> {
    return new Map(this.fieldSeq.get(id))
  }

  private refetchSession(id: string, requireExisting: boolean) {
    const rel = this.reloadSeq
    const del = this.deleteSeq.get(id) ?? 0
    const snap = this.fieldSnap(id)
    this.backend
      .getSession(id)
      .then((full) => {
        if (this.reloadSeq !== rel || (this.deleteSeq.get(id) ?? 0) !== del || this.deleted.has(id)) return
        const cur = this.sessions.get(id)
        if (requireExisting && !cur) return
        if (full.time?.archived) {
          this.cleanupSession(id)
          this.rebuildChildren()
          this.markStructure()
          return
        }
        const curFields = this.fieldSeq.get(id)
        const changed = (k: FieldKey) => (curFields?.get(k) ?? 0) > (snap.get(k) ?? 0)
        const merged: Session = cur
          ? {
              ...full,
              location: full.location ?? cur.location ?? { directory: "" },
              title: changed("title") ? cur.title : full.title,
              model: changed("model") ? cur.model : full.model,
              cost: changed("usage") ? cur.cost : full.cost,
              tokens: changed("usage") ? cur.tokens : full.tokens,
              outcome: changed("outcome")
                ? cur.outcome
                : (cur.outcome === "failed" || cur.outcome === "interrupted") &&
                    full.time.idle === cur.time.idle &&
                    (full.outcome === undefined || full.outcome === "succeeded")
                  ? cur.outcome
                  : full.outcome,
              permissions: changed("permissions")
                ? cur.permissions
                : full.permissions === undefined
                  ? cur.permissions
                  : full.permissions,
              time: {
                ...full.time,
                idle: changed("outcome") ? cur.time.idle : full.time.idle,
                updated: changed("updated") ? Math.max(full.time.updated, cur.time.updated) : full.time.updated,
                viewed: Math.max(full.time.viewed ?? 0, cur.time.viewed ?? 0) || undefined,
              },
            }
          : full
        this.sessions.set(id, merged)
        this.rebuildChildren()
        this.markStructure()
      })
      .catch(() => {})
  }

  private onEvent(ev: OcEvent) {
    const d = ev.data ?? {}
    const id: string | undefined = d.sessionID
    switch (ev.type) {
      case "session.created": {
        if (!id) break
        this.deleted.delete(id)
        const cur = this.sessions.get(id)
        const createdAt = ev.created ?? Date.now()
        const s: Session = cur
          ? {
              ...cur,
              parentID: d.parentID ?? cur.parentID,
              projectID: d.projectID ?? cur.projectID,
              agent: d.agent ?? cur.agent,
              model: d.model ?? cur.model,
              title: d.title ?? cur.title,
              location: d.location ?? ev.location ?? cur.location ?? { directory: "" },
            }
          : {
              id,
              parentID: d.parentID,
              projectID: d.projectID,
              agent: d.agent,
              model: d.model,
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: createdAt, updated: createdAt },
              title: d.title,
              location: d.location ?? ev.location ?? { directory: "" },
            }
        this.sessions.set(s.id, s)
        if (s.parentID && s.parentID !== s.id) {
          if (!this.children.has(s.parentID)) this.children.set(s.parentID, new Set())
          this.children.get(s.parentID)!.add(s.id)
          this.touchCard(s.parentID)
        }
        // The event lacks some fields (parentID on forks); fetch the real record.
        this.refetchSession(s.id, true)
        this.markStructure()
        break
      }
      case "session.deleted":
        if (id) {
          const had =
            this.sessions.has(id) ||
            this.running.has(id) ||
            this.permissions.has(id) ||
            this.forms.has(id) ||
            this.previews.has(id)
          this.cleanupSession(id)
          if (had) {
            this.rebuildChildren()
            this.markStructure()
          }
        }
        break
      case "session.renamed":
        this.patch(
          id,
          (s) => {
            s.title = d.title
            this.bumpField(s.id, "title")
          },
          true,
        )
        break
      case "session.moved":
      case "session.forked":
        if (id && !this.deleted.has(id)) this.refetchSession(id, false)
        break
      case "session.execution.started":
        if (!id) break
        this.sessionActiveSeq.set(id, ++this.activeClock)
        this.running.add(id)
        this.activity.set(id, "Working…")
        this.liveText.delete(id)
        this.patch(
          id,
          (s) => {
            s.time.updated = ev.created ?? Date.now()
            this.bumpField(s.id, "updated")
          },
          false,
        )
        this.markStructure()
        break
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        if (!id) break
        this.sessionActiveSeq.set(id, ++this.activeClock)
        this.running.delete(id)
        this.activity.delete(id)
        this.liveText.delete(id)
        this.clearSessionTools(id)
        this.patch(
          id,
          (s) => {
            s.outcome = ev.type.endsWith("succeeded") ? "succeeded" : ev.type.endsWith("failed") ? "failed" : "interrupted"
            const at = ev.created ?? Date.now()
            s.time.updated = at
            s.time.idle = at
            this.bumpField(s.id, "outcome")
            this.bumpField(s.id, "updated")
          },
          false,
        )
        this.refreshPreviewSoon(id, 250)
        break
      case "session.reasoning.started":
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
        if (id && d.id && typeof d.name === "string") this.trackTool(id, d.id, d.name)
        break
      case "session.tool.called":
        this.setActivity(id, describeTool((d.id ? this.toolNames.get(d.id) : undefined) ?? d.name ?? "tool", d.input))
        break
      case "session.tool.success":
      case "session.tool.failed":
        if (d.id) this.untrackTool(id, d.id)
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
          this.touchParent(id)
        }
        break
      case "session.inbox.cancelled":
        if (id) {
          const p = this.previews.get(id)
          if (p?.pendingUser !== undefined) {
            this.previews.set(id, { ...p, pendingUser: undefined })
            this.touchParent(id)
            this.refreshPreviewSoon(id, 150)
          }
        }
        break
      case "session.model.selected":
        this.patch(
          id,
          (s) => {
            s.model = d.model ?? s.model
            this.bumpField(s.id, "model")
          },
          false,
        )
        break
      case "session.usage.updated":
        this.patch(
          id,
          (s) => {
            s.cost = d.cost ?? s.cost
            s.tokens = d.tokens ?? s.tokens
            this.bumpField(s.id, "usage")
          },
          false,
        )
        break
      case "permission.asked":
        if (id && !this.deleted.has(id)) {
          this.bumpAskSeq(id, "perm")
          const list = (this.permissions.get(id) ?? []).filter((p) => p.id !== d.id)
          list.push(d as PermissionRequest)
          this.permissions.set(id, list)
          this.touchParent(id)
          this.maybeAutoApprove(d as PermissionRequest)
        }
        break
      case "permission.replied":
        if (id) {
          this.bumpAskSeq(id, "perm")
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
          this.bumpAskSeq(id, "form")
          void this.syncAsks(id)
          this.touchParent(id)
        }
        break
    }
    for (const l of this.listeners) this.safeCall(() => l.event?.(ev))
  }

  private toolNames = new Map<string, string>()

  private trackTool(sessionID: string, callID: string, name: string) {
    this.toolNames.set(callID, name)
    let set = this.sessionTools.get(sessionID)
    if (!set) {
      set = new Set()
      this.sessionTools.set(sessionID, set)
    }
    set.add(callID)
  }

  private untrackTool(sessionID: string | undefined, callID: string) {
    this.toolNames.delete(callID)
    if (!sessionID) return
    const set = this.sessionTools.get(sessionID)
    if (!set) return
    set.delete(callID)
    if (!set.size) this.sessionTools.delete(sessionID)
  }

  private clearSessionTools(sessionID: string) {
    const set = this.sessionTools.get(sessionID)
    if (!set) return
    for (const callID of set) this.toolNames.delete(callID)
    this.sessionTools.delete(sessionID)
  }

  private setActivity(id: string | undefined, label: string) {
    if (!id) return
    this.sessionActiveSeq.set(id, ++this.activeClock)
    if (!this.running.has(id)) this.running.add(id)
    if (this.activity.get(id) === label) return
    this.activity.set(id, label)
    this.touchParent(id)
  }

  private touchParent(id: string) {
    this.touchCard(id)
    const parent = this.sessions.get(id)?.parentID
    if (parent && parent !== id) this.touchCard(parent)
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
      this.clearFlushTimers()
      if (this.structureDirty) {
        this.structureDirty = false
        for (const l of this.listeners) this.safeCall(() => l.structure?.())
      }
      if (this.dirtyCards.size) {
        const ids = this.dirtyCards
        this.dirtyCards = new Set()
        for (const l of this.listeners) this.safeCall(() => l.cards?.(ids))
      }
    }
    if (typeof requestAnimationFrame === "function") {
      const raf = requestAnimationFrame(run)
      if (this.flushScheduled) this.flushRaf = raf
      else if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf)
    }
    if (this.flushScheduled) this.flushTimer = setTimeout(run, 300)
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
