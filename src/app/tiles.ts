// Tiles: every live session's chat side by side in an auto-sized grid, like a
// tiled terminal. Running and blocked sessions appear on their own; a tile
// that finishes stays (as "to review") until you open or dismiss it. Any
// session can be pinned.

import type { Backend } from "./backend"
import { timeAgo } from "./format"
import { spinner } from "./spinners"
import { REVIEW_WINDOW, type Status, type Store } from "./store"
import { toast } from "./toast"
import { Transcript } from "./transcript"
import { autoApproveToggle } from "./approve"
import type { InboxItem, Session } from "./types"

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const svg = (d: string) =>
  `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const ICONS = {
  pin: svg('<path d="M9.5 2.5l4 4-2.2.8-2.6 2.6.3 2.6-1.2 1.2-2.4-2.4L3 13.6M2.9 7.9l1.2-1.2 2.6.3 2.6-2.6z"/>'),
  max: svg('<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4.5 4.5M2.5 13.5 7 9"/>'),
  restore: svg('<path d="M13 7h-4V3M3 9h4v4M9 7l4.5-4.5M7 9l-4.5 4.5"/>'),
  open: svg('<path d="M6.5 3.5h-3v9h9v-3M9.5 2.5h4v4M13.5 2.5 7.5 8.5"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
}

const PINS_KEY = "occ.tiles.pins"
const SUBS_KEY = "occ.tiles.subagents"
const MIN_TILE_W = 360
const MIN_TILE_H = 300
const GAP = 10

/** Stable colour per project, so the same project reads the same everywhere. */
export function projectHue(key: string) {
  let x = 2166136261
  for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 16777619)
  return Math.abs(x) % 360
}

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* private mode */
  }
}

/** Grid that fills the area with tiles as close to 4:3 as possible. */
export function gridFor(n: number, w: number, hgt: number) {
  if (n <= 0) return { cols: 1, rows: 1, rowH: hgt }
  let best = { cols: 1, rows: n, score: Infinity }
  for (let cols = 1; cols <= n; cols++) {
    const tw = (w - GAP * (cols - 1)) / cols
    if (tw < MIN_TILE_W && cols > 1) break
    const rows = Math.ceil(n / cols)
    const th = (hgt - GAP * (rows - 1)) / rows
    const tooShort = th < MIN_TILE_H ? (MIN_TILE_H - th) / MIN_TILE_H : 0
    const empty = (cols * rows - n) / (cols * rows)
    const score = Math.abs(Math.log(tw / Math.max(th, MIN_TILE_H) / 1.33)) + tooShort * 2 + empty * 0.8
    if (score < best.score) best = { cols, rows, score }
  }
  const rowH = Math.max(MIN_TILE_H, (hgt - GAP * (best.rows - 1)) / best.rows)
  return { cols: best.cols, rows: best.rows, rowH }
}

class Tile {
  readonly root: HTMLElement
  readonly transcript: Transcript
  private titleEl: HTMLElement
  private projectEl: HTMLElement
  private statusEl: HTMLElement
  private stopBtn: HTMLButtonElement
  private pinBtn: HTMLButtonElement
  private maxBtn: HTMLButtonElement
  private input: HTMLTextAreaElement
  private hint: HTMLElement
  private state = ""

  constructor(
    readonly id: string,
    private view: TilesView,
    private store: Store,
    private backend: Backend,
  ) {
    this.root = h("article", "tile")
    this.root.dataset.id = id

    const head = h("header", "tile-head")
    const row = h("div", "tile-row")
    this.projectEl = h("span", "tile-project")
    this.statusEl = h("span", "tile-status")
    const actions = h("div", "tile-actions")
    this.stopBtn = this.button("Stop", "Interrupt", () => void this.transcript.act(() => this.backend.interrupt(id)), "stop")
    this.pinBtn = this.button(ICONS.pin, "Pin this tile", () => this.view.togglePin(id), "pin")
    this.maxBtn = this.button(ICONS.max, "Maximize (double-click the header)", () => this.view.toggleMax(id))
    const open = this.button(ICONS.open, "Open on the canvas", () => this.view.openOnCanvas(id))
    const close = this.button(ICONS.close, "Dismiss", () => this.view.dismiss(id))
    actions.append(this.pinBtn, this.maxBtn, open, close)
    row.append(this.projectEl, this.statusEl, this.stopBtn, actions)
    this.titleEl = h("div", "tile-title")
    head.append(row, this.titleEl)
    head.addEventListener("dblclick", (e) => {
      if (!(e.target as HTMLElement).closest("button")) this.view.toggleMax(id)
    })

    this.transcript = new Transcript(store, backend, {
      pageSize: 30,
      compact: true,
      onRender: () => this.update(),
      onFinished: () => this.update(),
    })
    this.transcript.scroller.classList.add("tile-scroll")

    const composer = h("div", "tile-composer")
    this.input = h("textarea", "tile-input") as HTMLTextAreaElement
    this.input.rows = 1
    this.hint = h("span", "tile-hint")
    composer.append(this.input, this.hint)
    this.bindComposer()

    this.root.append(head, this.transcript.scroller, composer)
    this.transcript.setSession(id)
    this.update()
  }

  private button(content: string, title: string, run: () => void, cls = "") {
    const b = h("button", `tile-btn ${cls}`.trim()) as HTMLButtonElement
    if (content.startsWith("<svg")) b.innerHTML = content
    else b.textContent = content
    b.title = title
    b.setAttribute("aria-label", title)
    b.addEventListener("click", (e) => {
      e.stopPropagation()
      run()
    })
    return b
  }

  update() {
    const s = this.store.sessions.get(this.id)
    if (!s) return
    const parent = s.parentID ? this.store.sessions.get(s.parentID) : undefined
    const project = this.store.projectLabel(s)
    this.projectEl.textContent = project
    this.projectEl.title = s.location.directory
    this.root.style.setProperty("--project-hue", String(projectHue(this.store.groupKey(parent ?? s))))
    this.titleEl.textContent = parent ? `${this.store.title(parent)} ▸ ${this.store.title(s)}` : this.store.title(s)
    this.titleEl.title = this.titleEl.textContent

    const status = this.view.statusOf(this.id)
    const ask = this.store.needsInput(this.id)
    const st = `${status}:${ask ?? ""}`
    if (st !== this.state) {
      this.state = st
      this.root.dataset.status = status
      this.statusEl.replaceChildren()
      if (status === "working") this.statusEl.append(spinner(12), h("span", "label"))
      else this.statusEl.append(h("span", `mark ${status}`), h("span", "label"))
    }
    const label = this.statusEl.querySelector(".label")!
    const ago = timeAgo(s.time.idle ?? s.time.updated)
    label.textContent =
      status === "working"
        ? this.store.activityLabel(this.id)
        : status === "needs-you"
          ? ask === "question"
            ? "Waiting for your answer"
            : "Needs permission"
          : status === "review"
            ? `Finished · ${ago}`
            : status === "failed"
              ? `Failed · ${ago}`
              : status === "stopped"
                ? `Stopped · ${ago}`
                : `Done · ${ago}`
    const working = status === "working" || status === "needs-you"
    this.root.classList.toggle("auto", this.store.sessionAutoApproves(this.id))
    this.stopBtn.hidden = !working
    const pinned = this.view.isPinned(this.id)
    this.pinBtn.classList.toggle("on", pinned)
    this.pinBtn.title = pinned ? "Unpin" : "Pin this tile"
    const maxed = this.view.maximized === this.id
    if (this.maxBtn.dataset.max !== String(maxed)) {
      this.maxBtn.dataset.max = String(maxed)
      this.maxBtn.innerHTML = maxed ? ICONS.restore : ICONS.max
      this.maxBtn.title = maxed ? "Restore (Esc)" : "Maximize (double-click the header)"
    }
    this.input.placeholder = working ? "Steer…" : "Reply…"
    this.hint.textContent = working ? "Tab to queue" : ""
  }

  private bindComposer() {
    const input = this.input
    input.addEventListener("input", () => {
      input.style.height = "auto"
      input.style.height = `${Math.min(120, input.scrollHeight)}px`
    })
    input.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.isComposing) return
      const running = this.store.running.has(this.id)
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        void this.send(running ? "steer" : undefined)
      } else if (e.key === "Tab" && !e.shiftKey && input.value.trim()) {
        e.preventDefault()
        void this.send("queue")
      } else if (e.key === "Escape") {
        e.preventDefault()
        input.blur()
      }
    })
  }

  private async send(delivery: "steer" | "queue" | undefined) {
    const text = this.input.value.trim()
    if (!text) return
    this.input.value = ""
    this.input.style.height = "auto"
    const temp: InboxItem = { id: `local_${Date.now()}`, sessionID: this.id, type: "user", payload: { text }, delivery: delivery ?? "steer" }
    this.transcript.addPending(temp)
    try {
      await this.backend.prompt(this.id, { text, delivery })
      this.transcript.scheduleRefetch(80)
    } catch (e) {
      this.transcript.removePending(temp)
      this.input.value = text
      toast(`Couldn't send: ${(e as Error).message}`)
    }
  }

  focus() {
    this.input.focus()
  }

  destroy() {
    this.transcript.destroy()
    this.root.remove()
  }
}

export class TilesView {
  readonly el: HTMLElement
  private grid: HTMLElement
  private countsEl: HTMLElement
  private empty: HTMLElement
  private subsToggle: HTMLInputElement
  private tiles = new Map<string, Tile>()
  private pins = new Set<string>(load<string[]>(PINS_KEY, []))
  /** Sessions shown here this visit: they linger as "to review" when done. */
  private seenHere = new Set<string>()
  /** Dismissed while running: hidden until their next run. */
  private hidden = new Set<string>()
  private includeSubagents = load<boolean>(SUBS_KEY, false)
  maximized?: string
  private open_ = false
  private syncQueued = false

  constructor(
    host: HTMLElement,
    private store: Store,
    private backend: Backend,
    private handlers: { openOnCanvas(id: string): void; newSession(): void; closed(): void },
  ) {
    this.el = h("section", "tiles-view")
    this.el.setAttribute("aria-label", "Tiled sessions")
    const bar = h("header", "tiles-bar")
    const title = h("div", "tiles-title")
    title.append(h("span", "tiles-name", "Tiles"))
    this.countsEl = h("span", "tiles-counts")
    title.append(this.countsEl)
    const tools = h("div", "tiles-tools")
    const subs = h("label", "tiles-toggle")
    this.subsToggle = h("input") as HTMLInputElement
    this.subsToggle.type = "checkbox"
    this.subsToggle.checked = this.includeSubagents
    this.subsToggle.addEventListener("change", () => {
      this.includeSubagents = this.subsToggle.checked
      save(SUBS_KEY, this.includeSubagents)
      this.sync()
    })
    subs.append(this.subsToggle, document.createTextNode(" Subagents"))
    const newBtn = h("button", "tiles-btn", "+ New session") as HTMLButtonElement
    newBtn.addEventListener("click", () => this.handlers.newSession())
    const back = h("button", "tiles-btn primary", "Canvas") as HTMLButtonElement
    back.title = "Back to the canvas (Esc)"
    back.addEventListener("click", () => this.close())
    tools.append(subs, autoApproveToggle(store), newBtn, back)
    bar.append(title, tools)

    this.grid = h("div", "tiles-grid")
    this.empty = h("div", "tiles-empty")
    this.el.append(bar, this.grid, this.empty)
    host.append(this.el)

    store.on({
      structure: () => this.queueSync(),
      cards: (ids) => {
        if (!this.open_) return
        let membership = false
        let touched = false
        for (const id of ids) {
          const t = this.tiles.get(id)
          if (t) {
            t.update()
            touched = true
          }
          if (this.wants(id) !== !!t) membership = true
        }
        if (membership) this.queueSync()
        else if (touched) this.renderCounts()
      },
    })
    new ResizeObserver(() => this.layout()).observe(this.grid)
    setInterval(() => {
      if (this.open_) for (const t of this.tiles.values()) t.update()
    }, 30_000)
  }

  get isOpen() {
    return this.open_
  }

  open() {
    if (this.open_) return
    this.open_ = true
    this.el.classList.add("visible")
    document.documentElement.classList.add("tiles-open")
    this.sync()
  }

  close() {
    if (!this.open_) return
    this.open_ = false
    this.el.classList.remove("visible")
    document.documentElement.classList.remove("tiles-open")
    // Live transcripts cost events and fetches; drop them while hidden.
    for (const t of this.tiles.values()) t.destroy()
    this.tiles.clear()
    this.maximized = undefined
    this.handlers.closed()
  }

  // ---- membership ----------------------------------------------------------------

  statusOf(id: string): Status {
    return this.store.status(id)
  }

  isPinned(id: string) {
    return this.pins.has(id)
  }

  togglePin(id: string) {
    if (this.pins.has(id)) this.pins.delete(id)
    else this.pins.add(id)
    save(PINS_KEY, [...this.pins])
    this.tiles.get(id)?.update()
    this.queueSync()
  }

  pin(id: string) {
    if (!this.pins.has(id)) this.togglePin(id)
  }

  /** Live counts for the top-bar button. */
  liveCount() {
    let n = 0
    for (const s of this.candidates()) if (this.wants(s.id)) n++
    return n
  }

  private candidates(): Session[] {
    return this.includeSubagents ? [...this.store.sessions.values()] : this.store.roots()
  }

  private wants(id: string): boolean {
    const s = this.store.sessions.get(id)
    if (!s) return false
    if (s.parentID && !this.includeSubagents && this.store.sessions.has(s.parentID)) return false
    if (this.pins.has(id)) return true
    const st = this.store.status(id)
    const live = st === "working" || st === "needs-you"
    if (live) {
      if (this.hidden.has(id)) return false
      return true
    }
    this.hidden.delete(id)
    // Finished while you were watching: keep it until you've looked.
    const fresh = this.store.unseen(id) && Date.now() - (s.time.idle ?? 0) < REVIEW_WINDOW
    return this.seenHere.has(id) && fresh
  }

  dismiss(id: string) {
    const st = this.store.status(id)
    if (this.pins.has(id)) this.togglePin(id)
    if (st === "working" || st === "needs-you") this.hidden.add(id)
    else this.store.markViewed(id)
    this.seenHere.delete(id)
    if (this.maximized === id) this.maximized = undefined
    this.queueSync()
  }

  toggleMax(id: string) {
    this.maximized = this.maximized === id ? undefined : id
    for (const t of this.tiles.values()) t.update()
    this.layout()
    if (this.maximized) this.tiles.get(id)?.focus()
  }

  openOnCanvas(id: string) {
    this.close()
    this.handlers.openOnCanvas(id)
  }

  // ---- rendering -------------------------------------------------------------------

  private queueSync() {
    if (this.syncQueued || !this.open_) return
    this.syncQueued = true
    queueMicrotask(() => {
      this.syncQueued = false
      this.sync()
    })
  }

  private sync() {
    if (!this.open_) return
    const want = this.candidates().filter((s) => this.wants(s.id))
    // Group by project so neighbours share a colour; stable within a project.
    const key = (s: Session) => {
      const root = s.parentID ? (this.store.sessions.get(s.parentID) ?? s) : s
      return `${this.store.projectLabel(root)}\u0000${root.time.created}\u0000${s.parentID ? s.time.created : 0}`
    }
    want.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    const ids = new Set(want.map((s) => s.id))
    for (const [id, t] of this.tiles)
      if (!ids.has(id)) {
        t.destroy()
        this.tiles.delete(id)
        if (this.maximized === id) this.maximized = undefined
      }
    let prev: Element | null = null
    for (const s of want) {
      this.seenHere.add(s.id)
      let t = this.tiles.get(s.id)
      if (!t) {
        t = new Tile(s.id, this, this.store, this.backend)
        this.tiles.set(s.id, t)
      }
      const next: Element | null = prev ? prev.nextElementSibling : this.grid.firstElementChild
      if (next !== t.root) this.grid.insertBefore(t.root, next)
      prev = t.root
    }
    this.renderCounts()
    this.layout()
  }

  private renderCounts() {
    const c = { "needs-you": 0, working: 0, review: 0 }
    for (const id of this.tiles.keys()) {
      const st = this.store.status(id)
      if (st === "needs-you") c["needs-you"]++
      else if (st === "working") c.working++
      else if (st === "review" || st === "failed") c.review++
    }
    const parts: string[] = []
    if (c["needs-you"]) parts.push(`<span class="tc needs-you">${c["needs-you"]} need${c["needs-you"] === 1 ? "s" : ""} you</span>`)
    if (c.working) parts.push(`<span class="tc working">${c.working} working</span>`)
    if (c.review) parts.push(`<span class="tc review">${c.review} to review</span>`)
    this.countsEl.innerHTML = parts.join("")
    const n = this.tiles.size
    this.empty.hidden = n > 0
    if (!n)
      this.empty.innerHTML = `<div class="tiles-empty-mark">▦</div><h2>Nothing running right now</h2><p>Sessions appear here while they work and stay until you've reviewed them. Pin any session from its <b>⋯</b> menu to keep it here.</p>`
  }

  private layout() {
    if (!this.open_) return
    const tiles = [...this.tiles.values()]
    const max = this.maximized ? this.tiles.get(this.maximized) : undefined
    for (const t of tiles) t.root.classList.toggle("off", !!max && t !== max)
    const shown = max ? 1 : tiles.length
    const r = this.grid.getBoundingClientRect()
    const g = gridFor(shown, r.width || innerWidth, r.height || innerHeight - 60)
    this.grid.style.gridTemplateColumns = `repeat(${g.cols}, minmax(0, 1fr))`
    this.grid.style.gridAutoRows = `${Math.floor(g.rowH)}px`
    this.grid.classList.toggle("scrolls", g.rowH * g.rows + GAP * (g.rows - 1) > (r.height || 0) + 1)
  }
}
