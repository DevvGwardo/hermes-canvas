// The infinite canvas: owns the world DOM, card springs, camera input,
// culling, keyboard selection, and layout switching.

import { Camera, type Rect } from "./camera"
import { createNewCard, createSessionCard, updateSessionCard, type CardEls } from "./card"
import { matchesQuery } from "./format"
import {
  CARD_W,
  NEW_CARD_H,
  layout,
  type LayoutGroup,
  type LayoutName,
  type LayoutResult,
  type Placement,
} from "./layouts"
import { STATUS_LABEL, type Status, type Store } from "./store"

interface Spring {
  x: number
  y: number
  s: number
  r: number
  o: number
  vx: number
  vy: number
  vs: number
  vr: number
  vo: number
}

interface CardView {
  id: string
  kind: "session" | "new"
  group: string
  root: HTMLElement
  els?: CardEls
  h: number
  target?: Placement
  sp: Spring
  settled: boolean
  culled: boolean
  blur: number
  fresh?: boolean
}

export interface CanvasHandlers {
  open(id: string): void
  newSession(groupKey: string): void
  selectionChanged?(id: string | undefined): void
}

const STIFF = 190
const DAMP = 2 * Math.sqrt(STIFF) * 0.92

function stepSpring(sp: Spring, t: Placement, dt: number): boolean {
  const keys: Array<[keyof Spring, keyof Spring, number]> = [
    ["x", "vx", t.x],
    ["y", "vy", t.y],
    ["s", "vs", t.scale],
    ["r", "vr", t.rot],
    ["o", "vo", t.opacity],
  ]
  let moving = false
  for (const [k, vk, target] of keys) {
    const x = sp[k] as number
    const v = sp[vk] as number
    const a = STIFF * (target - x) - DAMP * v
    const nv = v + a * dt
    const nx = x + nv * dt
    const tol = k === "x" || k === "y" ? 0.08 : 0.0008
    if (Math.abs(target - nx) < tol && Math.abs(nv) < tol * 20) {
      ;(sp as any)[k] = target
      ;(sp as any)[vk] = 0
    } else {
      ;(sp as any)[k] = nx
      ;(sp as any)[vk] = nv
      moving = true
    }
  }
  return moving
}

export class CanvasView {
  readonly camera: Camera
  readonly stage: HTMLElement
  readonly world: HTMLElement
  private labelsLayer: HTMLElement
  private cards = new Map<string, CardView>()
  private labels = new Map<string, HTMLElement>()
  private labelTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private result?: LayoutResult
  private layoutName: LayoutName = "tree"
  private query = ""
  private expanded?: string
  private needsLayout = true
  private firstLayout = true
  private fitAfterLayout = false
  private heightsDirty = new Set<string>()
  private frameScheduled = false
  private rafId = 0
  private lastFrame = performance.now()
  private cameraDirty = true
  private lastPreviewScan = 0
  private openId?: string
  private accentH = 0
  private ac = new AbortController()
  private inputUnsubs: Array<() => void> = []
  private unsubStore: () => void
  private ro: ResizeObserver
  private tickTimer: ReturnType<typeof setInterval>
  private destroyed = false
  selected?: string

  constructor(
    private host: HTMLElement,
    private store: Store,
    private handlers: CanvasHandlers,
  ) {
    this.stage = document.createElement("div")
    this.stage.className = "stage"
    this.world = document.createElement("div")
    this.world.className = "world"
    this.labelsLayer = document.createElement("div")
    this.labelsLayer.className = "labels"
    this.world.append(this.labelsLayer)
    this.stage.append(this.world)
    host.append(this.stage)

    this.camera = new Camera(() => this.kick())
    this.ro = new ResizeObserver(() => {
      const w = this.stage.clientWidth
      const h = this.stage.clientHeight
      if (w <= 0 || h <= 0) return
      this.camera.setViewport(w, h)
      this.cameraDirty = true
      this.needsLayout = true
      this.kick()
    })
    this.ro.observe(this.stage)
    const fallbackW = typeof innerWidth === "number" ? innerWidth : 1200
    const fallbackH = typeof innerHeight === "number" ? innerHeight : 800
    this.camera.setViewport(this.stage.clientWidth || fallbackW, this.stage.clientHeight || fallbackH)

    this.bindInput()

    this.unsubStore = store.on({
      structure: () => this.sync(),
      cards: (ids) => this.updateCards(ids),
    })
    this.tickTimer = setInterval(() => this.updateCards(new Set(this.cards.keys())), 30_000)
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.ac.abort()
    for (const off of this.inputUnsubs) off()
    this.inputUnsubs = []
    this.unsubStore()
    this.ro.disconnect()
    clearInterval(this.tickTimer)
    if (this.rafId && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.frameScheduled = false
    for (const t of this.labelTimers.values()) clearTimeout(t)
    this.labelTimers.clear()
    this.camera.release(0, 0)
    this.stage.remove()
  }

  // ---- public ---------------------------------------------------------------

  get layoutMode() {
    return this.layoutName
  }

  setLayout(name: LayoutName) {
    if (name === this.layoutName) return
    this.layoutName = name
    this.expanded = undefined
    this.host.dataset.layout = name
    this.relayout(true)
  }

  private statusFilter?: Status

  get filter() {
    return this.statusFilter
  }

  private get isFiltered() {
    return !!(this.query || this.statusFilter)
  }

  setStatusFilter(f: Status | undefined) {
    if (f === this.statusFilter) return
    this.statusFilter = f
    this.relayout(true)
  }

  private remoteHits = new Set<string>()
  private remoteSeq = 0

  setQuery(q: string) {
    const next = q.trim()
    if (next === this.query) return
    const was = !!this.query
    this.query = next
    this.remoteHits = new Set()
    const seq = ++this.remoteSeq
    this.relayout(!was || !next)
    if (!next) return
    // The server also searches content we haven't loaded into previews yet.
    this.store.backend
      .searchSessions(next)
      .then((found) => {
        if (this.destroyed || seq !== this.remoteSeq || this.query !== next || !found.length) return
        this.remoteHits = new Set(found.map((s) => s.id))
        // Older sessions outside the initial page join the canvas on demand.
        const missing = found.filter((s) => !this.store.sessions.has(s.id) && !s.time.archived)
        if (missing.length) this.store.addSessions(missing)
        this.relayout(true)
      })
      .catch(() => {})
  }

  get stackOpen() {
    return !!this.expanded && !this.isFiltered
  }

  closeStack() {
    if (!this.expanded || this.isFiltered) return false
    const g = this.expanded
    this.expanded = undefined
    this.relayout(false)
    this.ensureLayout()
    const r = this.result?.groups.get(g)
    if (r) this.camera.fit(r, 120, Math.min(1, this.camera.z))
    return true
  }

  setOpen(id: string | undefined) {
    if (this.openId) this.cards.get(this.openId)?.root.classList.remove("is-open")
    this.openId = id
    this.host.classList.toggle("dimmed", !!id)
    if (id) this.cards.get(id)?.root.classList.add("is-open")
  }

  /** Screen rect of a card as currently displayed. */
  cardRect(id: string): DOMRect | undefined {
    this.ensureLayout()
    const c = this.cards.get(id)
    if (!c) return undefined
    const t = c.sp
    const w = CARD_W * t.s
    const h = c.h * t.s
    const cx = t.x + CARD_W / 2
    const cy = t.y + c.h / 2
    const p = this.camera.toScreen(cx, cy)
    const z = this.camera.z
    const r = this.stage.getBoundingClientRect()
    return new DOMRect(r.left + p.x - (w * z) / 2, r.top + p.y - (h * z) / 2, w * z, h * z)
  }

  /** Bring a card to the middle of the screen at a readable zoom. */
  centerOn(id: string, zoom?: number) {
    this.ensureLayout()
    const c = this.cards.get(id)
    const t = c?.target
    if (!c || !t) return
    this.camera.animateTo(t.x + CARD_W / 2, t.y + c.h / 2, zoom ?? Math.max(this.camera.z, 0.9))
  }

  fitAll() {
    this.ensureLayout()
    if (!this.result) return
    this.camera.fit(this.result.bounds, 72, 1)
  }

  zoomBy(f: number) {
    this.camera.zoomAt(f, this.camera.viewport.w / 2, this.camera.viewport.h / 2)
  }

  hasSession(id: string) {
    return this.cards.has(id)
  }

  // ---- reconciliation -------------------------------------------------------

  private groupsCache: ReturnType<Store["groups"]> = []

  private ensureLayout() {
    if (this.needsLayout && this.cards.size) {
      this.measure()
      this.doLayout()
    }
  }

  private sync() {
    if (this.destroyed) return
    const groups = this.store.groups()
    this.groupsCache = groups
    if (this.expanded && !groups.some((g) => g.key === this.expanded)) this.expanded = undefined
    const seen = new Set<string>()
    let added = 0
    for (const g of groups) {
      for (const s of g.sessions) {
        seen.add(s.id)
        let c = this.cards.get(s.id)
        if (!c) {
          added++
          const els = createSessionCard(s.id)
          c = this.addCard(s.id, "session", g.key, els.root)
          c.els = els
          updateSessionCard(els, this.store, s.id)
          this.heightsDirty.add(s.id)
        }
        if (c.group !== g.key) c.group = g.key
      }
      const nid = `new:${g.key}`
      seen.add(nid)
      if (!this.cards.has(nid)) {
        const c = this.addCard(nid, "new", g.key, createNewCard(g.key))
        c.h = NEW_CARD_H
      }
    }
    let deselected = false
    for (const [id, c] of this.cards) {
      if (seen.has(id)) continue
      c.root.remove()
      this.cards.delete(id)
      this.heightsDirty.delete(id)
      if (this.openId === id) this.openId = undefined
      if (this.selected === id) {
        this.selected = undefined
        deselected = true
      }
    }
    if (deselected) this.handlers.selectionChanged?.(undefined)
    this.updateCards(new Set(this.cards.keys()))
    this.relayout(added > 0 && !!this.query)
  }

  private addCard(id: string, kind: "session" | "new", group: string, root: HTMLElement): CardView {
    root.style.width = `${CARD_W}px`
    const c: CardView = {
      id,
      kind,
      group,
      root,
      h: kind === "new" ? NEW_CARD_H : 180,
      sp: { x: 0, y: 0, s: 0.92, r: 0, o: 0, vx: 0, vy: 0, vs: 0, vr: 0, vo: 0 },
      settled: false,
      culled: false,
      blur: 0,
      fresh: true,
    }
    this.world.append(root)
    this.cards.set(id, c)
    return c
  }

  private updateCards(ids: Set<string>) {
    if (this.destroyed) return
    const now = Date.now()
    const touchedGroups = new Set<string>()
    for (const id of ids) {
      const c = this.cards.get(id)
      if (!c?.els) continue
      const before = c.root.dataset.status
      if (updateSessionCard(c.els, this.store, id, now)) this.heightsDirty.add(id)
      touchedGroups.add(c.group)
      // A status change reorders its project (and the filtered grid).
      if (before !== undefined && before !== c.root.dataset.status) {
        this.groupsCache = this.store.groups()
        this.needsLayout = true
      }
    }
    if (!this.needsLayout) {
      for (const gKey of touchedGroups) {
        const marks = this.labels.get(gKey)?.querySelector(".marks")
        if (marks) this.renderLabelMarks(marks, gKey)
      }
    }
    this.kick()
  }

  private measure() {
    if (!this.heightsDirty.size) return
    let changed = false
    for (const id of this.heightsDirty) {
      const c = this.cards.get(id)
      // A stacked card is deliberately clipped to the front card's height, so
      // measuring it would lose the card's real height for when the pile opens.
      if (!c || c.kind !== "session" || c.root.classList.contains("stacked")) continue
      const h = c.root.offsetHeight
      if (h && Math.abs(h - c.h) > 1) {
        c.h = h
        changed = true
      }
    }
    this.heightsDirty.clear()
    if (changed) this.needsLayout = true
  }

  private relayout(fitCamera: boolean) {
    this.needsLayout = true
    this.fitAfterLayout = fitCamera || this.fitAfterLayout
    this.kick()
  }

  private doLayout() {
    this.needsLayout = false
    const groups: LayoutGroup[] = this.groupsCache.map((g) => ({
      key: g.key,
      label: g.label,
      items: [
        ...g.sessions.map((s) => ({
          id: s.id,
          kind: "session" as const,
          h: this.cards.get(s.id)?.h ?? 180,
          updated: this.store.isWorking(s.id) ? Date.now() : s.time.updated,
        })),
        { id: `new:${g.key}`, kind: "new" as const, h: NEW_CARD_H, updated: 0 },
      ],
    }))
    const q = this.query
    const f = this.statusFilter
    const t = Date.now()
    const textMatch = (id: string) => {
      if (!q) return true
      const s = this.store.sessions.get(id)
      if (!s) return false
      if (this.remoteHits.has(id)) return true
      for (const k of this.store.children.get(id) ?? []) if (this.remoteHits.has(k)) return true
      const p = this.store.previews.get(id)
      return matchesQuery(q, s.title, this.store.projectLabel(s), s.location.directory, p?.text, p?.bullets.join(" "), s.id)
    }
    const query = q || f ? (id: string) => (!f || this.store.inFilter(id, f, t)) && textMatch(id) : undefined
    const resultLabel = f
      ? (n: number) => (n ? `${n} ${STATUS_LABEL[f].toLowerCase()}${q ? ` matching “${q}”` : ""}` : `Nothing ${STATUS_LABEL[f].toLowerCase()}`)
      : undefined
    const prev = this.result
    const aspect = Math.min(3, Math.max(0.5, this.camera.viewport.w / Math.max(1, this.camera.viewport.h)))
    this.result = layout(this.layoutName, groups, { expanded: this.expanded, query, aspect, resultLabel }, prev)

    for (const [id, c] of this.cards) {
      const t = this.result.cards.get(id)
      if (!t) continue
      c.target = t
      c.root.style.zIndex = String(t.z)
      c.root.classList.toggle("inert", !t.interactive)
      const stacked = !!t.stacked
      if (c.root.classList.contains("stacked") !== stacked) {
        c.root.classList.toggle("stacked", stacked)
        // Back cards are height-clipped while stacked; re-measure when one
        // rejoins the normal grid so it gets its real height back.
        if (!stacked) this.heightsDirty.add(id)
      }
      if (stacked) c.root.style.setProperty("--stack-h", `${Math.round(t.h)}px`)
      if (c.fresh || this.firstLayout) {
        c.fresh = false
        c.sp.x = t.x
        c.sp.y = t.y
        c.sp.r = t.rot
        if (this.firstLayout) {
          c.sp.s = t.scale
          c.sp.o = t.opacity
        } else {
          c.sp.s = t.scale * 0.9
          c.sp.o = 0
        }
      }
      c.settled = false
    }
    if (this.selected) {
      const sc = this.cards.get(this.selected)
      if (sc?.target && this.isFiltered && !sc.target.interactive) {
        this.select(undefined, false)
      }
    }
    this.renderLabels()
    this.camera.setBounds(this.result.bounds)

    if (this.firstLayout && this.groupsCache.length) {
      this.firstLayout = false
      this.initialCamera()
    } else if (this.fitAfterLayout) {
      const b = this.isFiltered ? (this.result.groups.get("__search") ?? this.result.bounds) : this.result.bounds
      this.camera.fit(b, 72, 1)
    }
    this.fitAfterLayout = false
    this.cameraDirty = true
  }

  private initialCamera() {
    const b = this.result!.bounds
    const fitZ = this.camera.fitZoom(b, 64, 1)
    if (fitZ >= 0.6) return this.camera.fit(b, 64, 1, false)
    const z = 0.85
    const vw = this.camera.viewport.w / z
    const vh = this.camera.viewport.h / z
    this.camera.jumpTo(b.x + vw / 2 - 56 / z, b.y + vh / 2 - 84 / z, z)
  }

  private renderLabels() {
    const seen = new Set<string>()
    for (const l of this.result!.labels) {
      seen.add(l.key)
      const pending = this.labelTimers.get(l.key)
      if (pending !== undefined) {
        clearTimeout(pending)
        this.labelTimers.delete(l.key)
      }
      let e = this.labels.get(l.key)
      if (!e) {
        e = document.createElement("div")
        e.className = "group-label"
        e.innerHTML = `<span class="name"></span><span class="marks"></span><span class="count"></span>`
        e.style.transform = `translate(${l.x}px, ${l.y}px)`
        this.labelsLayer.append(e)
        this.labels.set(l.key, e)
        e.dataset.group = l.key
      }
      e.querySelector(".name")!.textContent = l.text
      ;(e.querySelector(".name") as HTMLElement).title = l.text
      e.querySelector(".count")!.textContent = l.sub ?? ""
      e.title = l.sub ? `${l.text} · ${l.sub}` : l.text
      this.renderLabelMarks(e.querySelector(".marks")!, l.key)
      e.style.width = `${l.w}px`
      e.style.transform = `translate(${l.x}px, ${l.y}px)`
      e.classList.remove("gone")
    }
    for (const [k, e] of this.labels) {
      if (seen.has(k)) continue
      if (e.classList.contains("gone") && this.labelTimers.has(k)) continue
      e.classList.add("gone")
      const timer = setTimeout(() => {
        this.labelTimers.delete(k)
        if (!this.destroyed && this.labels.get(k) === e && e.classList.contains("gone")) {
          e.remove()
          this.labels.delete(k)
        }
      }, 400)
      this.labelTimers.set(k, timer)
    }
  }

  /** "● 2 working  ● 1 needs you" beside a project name. */
  private renderLabelMarks(host: Element, groupKey: string) {
    const g = this.groupsCache.find((x) => x.key === groupKey)
    const counts = { "needs-you": 0, working: 0, review: 0 }
    if (g) {
      const t = Date.now()
      for (const s of g.sessions) {
        if (this.store.inFilter(s.id, "needs-you", t)) counts["needs-you"]++
        else if (this.store.inFilter(s.id, "working", t)) counts.working++
        else if (this.store.inFilter(s.id, "review", t)) counts.review++
      }
    }
    const key = `${counts["needs-you"]}/${counts.working}/${counts.review}`
    const labelEl = (host as HTMLElement).closest(".group-label")
    labelEl?.classList.toggle("has-marks", counts["needs-you"] + counts.working + counts.review > 0)
    if ((host as HTMLElement).dataset.key === key) return
    ;(host as HTMLElement).dataset.key = key
    host.replaceChildren(
      ...(Object.entries(counts) as Array<[Status, number]>)
        .filter(([, n]) => n > 0)
        .map(([st, n]) => {
          const m = document.createElement("span")
          m.className = `gl-mark ${st}`
          m.textContent = `${n} ${STATUS_LABEL[st].toLowerCase()}`
          return m
        }),
    )
  }

  // ---- frame loop -----------------------------------------------------------

  kick() {
    if (this.destroyed || this.frameScheduled) return
    this.frameScheduled = true
    this.rafId = requestAnimationFrame((t) => {
      this.rafId = 0
      this.frame(t)
    })
  }

  private frame(now: number) {
    if (this.destroyed) return
    this.frameScheduled = false
    const dt = Math.min(1 / 30, Math.max(0.001, (now - this.lastFrame) / 1000))
    this.lastFrame = now

    this.measure()
    if (this.needsLayout) this.doLayout()

    let active = this.camera.step(dt)
    const camMoving = active || this.cameraDirty
    if (camMoving) {
      this.world.style.transform = this.camera.transform()
      // Status edges stay ~3 screen pixels tall at any zoom.
      const accent = Math.min(48, Math.max(2, 3 / this.camera.z))
      if (Math.abs(accent - this.accentH) > 0.25) {
        this.accentH = accent
        this.world.style.setProperty("--accent-h", `${accent.toFixed(1)}px`)
      }
      this.cameraDirty = false
    }
    // Text re-rasterises crisply once the camera rests.
    this.world.classList.toggle("moving", active)

    const vis = this.camera.visibleWorld(260 / this.camera.z)
    const z = this.camera.z
    const scanPreviews = now - this.lastPreviewScan > 200
    if (scanPreviews) this.lastPreviewScan = now

    for (const c of this.cards.values()) {
      const t = c.target
      if (!t) continue
      if (!c.settled && c.culled) {
        // Off screen now and at the destination: no one sees the flight.
        const destVisible =
          t.opacity > 0.01 && t.x + CARD_W > vis.x && t.x < vis.x + vis.w && t.y + c.h > vis.y && t.y < vis.y + vis.h
        if (!destVisible) {
          Object.assign(c.sp, { x: t.x, y: t.y, s: t.scale, r: t.rot, o: t.opacity, vx: 0, vy: 0, vs: 0, vr: 0, vo: 0 })
        }
      }
      if (!c.settled) {
        const moving = stepSpring(c.sp, t, dt)
        if (moving) active = true
        else c.settled = true
        const sp = c.sp
        c.root.style.transform = `translate3d(${sp.x}px, ${sp.y}px, 0) rotate(${sp.r}deg) scale(${sp.s})`
        c.root.style.opacity = String(Math.max(0, Math.min(1, sp.o)))
        // Motion blur proportional to on-screen speed.
        const speed = Math.hypot(sp.vx, sp.vy) * z
        const blur = moving && !c.culled && t.opacity > 0 ? Math.min(7, Math.max(0, (speed - 900) / 300)) : 0
        if (Math.abs(blur - c.blur) > 0.25 || (blur === 0 && c.blur !== 0)) {
          c.blur = blur
          c.root.style.filter = blur > 0.25 ? `blur(${blur.toFixed(1)}px)` : ""
        }
      }
      if (camMoving || !c.settled) {
        const sp = c.sp
        const inView =
          sp.o > 0.01 &&
          sp.x + CARD_W > vis.x &&
          sp.x < vis.x + vis.w &&
          sp.y + c.h > vis.y &&
          sp.y < vis.y + vis.h
        if (inView === c.culled) {
          c.culled = !inView
          c.root.classList.toggle("culled", c.culled)
        }
      }
      if (scanPreviews && !c.culled && c.kind === "session") this.store.wantPreview(c.id)
    }

    if (active || this.needsLayout || this.heightsDirty.size) this.kick()
  }

  // ---- input ----------------------------------------------------------------

  private bindInput() {
    const stage = this.stage
    const listen = <K extends string>(
      target: { addEventListener: Function; removeEventListener?: Function },
      type: K,
      fn: (e: any) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn, { ...opts, signal: this.ac.signal })
      this.inputUnsubs.push(() => target.removeEventListener?.(type, fn, opts))
    }

    listen(
      stage,
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault()
        const pageH = typeof innerHeight === "number" ? innerHeight : 800
        const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageH : 1
        const r = stage.getBoundingClientRect()
        if (e.ctrlKey || e.metaKey) {
          const exp = Math.max(-4, Math.min(4, -e.deltaY * k * 0.0105))
          this.camera.zoomAt(Math.exp(exp), e.clientX - r.left, e.clientY - r.top)
        } else {
          this.camera.panBy(e.deltaX * k, e.deltaY * k)
        }
      },
      { passive: false },
    )

    // Safari trackpad pinch.
    let gestureScale = 1
    listen(stage, "gesturestart", (e: any) => {
      e.preventDefault()
      gestureScale = 1
      this.camera.hold()
    })
    listen(stage, "gesturechange", (e: any) => {
      e.preventDefault()
      if (!Number.isFinite(e.scale) || e.scale <= 0 || gestureScale <= 0) return
      const r = stage.getBoundingClientRect()
      this.camera.zoomAt(e.scale / gestureScale, e.clientX - r.left, e.clientY - r.top)
      gestureScale = e.scale
    })
    const endGesture = (e?: any) => {
      e?.preventDefault?.()
      gestureScale = 1
      this.camera.release(0, 0)
    }
    listen(stage, "gestureend", endGesture)
    listen(stage, "gesturecancel", endGesture)

    const pointers = new Map<number, { x: number; y: number }>()
    let drag:
      | { id: number; x0: number; y0: number; x: number; y: number; panning: boolean; samples: Array<{ x: number; y: number; t: number }> }
      | undefined
    let pinch: { ids: [number, number]; d: number; mx: number; my: number } | undefined

    const stopDrag = (releaseCamera: boolean, vx = 0, vy = 0) => {
      drag = undefined
      stage.classList.remove("grabbing")
      if (releaseCamera) this.camera.release(vx, vy)
    }

    const resetAllInput = () => {
      const wasHolding = !!pinch || !!drag?.panning
      pointers.clear()
      pinch = undefined
      stopDrag(wasHolding, 0, 0)
    }

    listen(stage, "pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2 && !pinch) {
        const [[idA, a], [idB, b]] = [...pointers.entries()]
        pinch = { ids: [idA, idB], d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
        stopDrag(false)
        this.camera.hold()
        return
      }
      if (pinch || pointers.size > 2) return
      drag = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        x: e.clientX,
        y: e.clientY,
        panning: false,
        samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }],
      }
    })

    listen(stage, "pointermove", (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return
      if (e.pointerType === "mouse" && e.buttons === 0) {
        resetAllInput()
        return
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pinch) {
        const a = pointers.get(pinch.ids[0])
        const b = pointers.get(pinch.ids[1])
        if (!a || !b) return
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const r = stage.getBoundingClientRect()
        this.camera.panBy(pinch.mx - mx, pinch.my - my)
        if (d > 1 && pinch.d > 1) {
          this.camera.zoomAt(d / pinch.d, mx - r.left, my - r.top)
        }
        pinch = { ids: pinch.ids, d: d > 1 ? d : pinch.d, mx, my }
        return
      }
      if (!drag || drag.id !== e.pointerId) return
      if (!drag.panning && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 5) {
        drag.panning = true
        try {
          stage.setPointerCapture?.(e.pointerId)
        } catch {
          /* synthetic events */
        }
        stage.classList.add("grabbing")
        this.camera.hold()
      }
      if (drag.panning) {
        this.camera.panBy(drag.x - e.clientX, drag.y - e.clientY)
        this.camera.hold()
        const t = performance.now()
        drag.samples.push({ x: e.clientX, y: e.clientY, t })
        while (drag.samples.length > 2 && t - drag.samples[0].t > 90) drag.samples.shift()
      }
      drag.x = e.clientX
      drag.y = e.clientY
    })

    const end = (e: PointerEvent) => {
      const hadPointer = pointers.delete(e.pointerId)
      if (pinch) {
        if (pinch.ids[0] === e.pointerId || pinch.ids[1] === e.pointerId || pointers.size < 2) {
          if (pointers.size >= 2) {
            const [[idA, a], [idB, b]] = [...pointers.entries()]
            pinch = { ids: [idA, idB], d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
          } else {
            pinch = undefined
            stage.classList.remove("grabbing")
            this.camera.release(0, 0)
          }
        }
        return
      }
      if (!hadPointer || !drag || drag.id !== e.pointerId) return
      const d = drag
      drag = undefined
      stage.classList.remove("grabbing")
      if (d.panning) {
        const a = d.samples[0]
        const b = d.samples[d.samples.length - 1]
        const dt = Math.max(16, b.t - a.t) / 1000
        const stale = e.type !== "pointerup" || performance.now() - b.t > 80
        this.camera.release(stale ? 0 : (a.x - b.x) / dt, stale ? 0 : (a.y - b.y) / dt)
        return
      }
      if (e.type !== "pointerup") return
      const t = e.target as Element | null
      const el = typeof Element !== "undefined" ? (t instanceof Element ? t : null) : t && typeof t.closest === "function" ? t : null
      const target = el?.closest<HTMLElement>(".card")
      if (target && !target.classList.contains("inert")) this.activate(target.dataset.id!)
      else {
        const lbl = el?.closest<HTMLElement>(".group-label")
        if (lbl?.dataset.group && this.layoutName === "fold" && !this.isFiltered) this.openStack(lbl.dataset.group)
      }
    }
    listen(stage, "pointerup", end)
    listen(stage, "pointercancel", end)
    listen(stage, "lostpointercapture", end)
    if (typeof window !== "undefined" && typeof (window as any).addEventListener === "function") {
      listen(window, "blur", resetAllInput)
    }

    listen(stage, "dblclick", (e: MouseEvent) => {
      const t = e.target as Element | null
      const el = typeof Element !== "undefined" ? (t instanceof Element ? t : null) : t && typeof t.closest === "function" ? t : null
      if (el?.closest(".card, .group-label")) return
      this.fitAll()
    })
  }

  activate(id: string) {
    const c = this.cards.get(id)
    if (!c) return
    if (c.target && !c.target.stacked && c.target.opacity <= 0.01) return
    if (this.isFiltered && c.target && !c.target.interactive) return
    this.select(id, false)
    if (c.kind === "new") return this.handlers.newSession(c.group)
    if (this.layoutName === "fold" && !this.isFiltered && this.expanded !== c.group) return this.openStack(c.group)
    this.handlers.open(id)
  }

  openStack(group: string) {
    if (this.isFiltered || !this.groupsCache.some((g) => g.key === group)) return
    this.expanded = group
    this.needsLayout = true
    this.doLayout()
    const r = this.result?.groups.get(group)
    if (r) this.camera.fit(r, 90, 1)
    this.kick()
  }

  // ---- selection / keyboard ---------------------------------------------------

  select(id: string | undefined, reveal = true) {
    if (this.selected) this.cards.get(this.selected)?.root.classList.remove("selected")
    this.selected = id
    const c = id ? this.cards.get(id) : undefined
    c?.root.classList.add("selected")
    this.handlers.selectionChanged?.(id)
    if (c && reveal && c.target) {
      const t = c.target
      const vis = this.camera.visibleWorld(-40 / this.camera.z)
      const inside = t.x >= vis.x && t.y >= vis.y && t.x + CARD_W <= vis.x + vis.w && t.y + c.h <= vis.y + vis.h
      if (!inside) this.camera.animateTo(t.x + CARD_W / 2, t.y + c.h / 2, Math.max(this.camera.z, 0.75), 380)
    }
  }

  moveSelection(dx: number, dy: number) {
    this.ensureLayout()
    const candidates = [...this.cards.values()].filter((c) => c.target?.interactive && (c.target?.opacity ?? 0) > 0.5)
    if (!candidates.length) return
    const center = (c: CardView) => ({ x: c.target!.x + CARD_W / 2, y: c.target!.y + c.h / 2 })
    const cur = this.selected ? this.cards.get(this.selected) : undefined
    if (!cur?.target) {
      const mid = { x: this.camera.cx, y: this.camera.cy }
      const best = candidates.reduce((a, b) => {
        const da = Math.hypot(center(a).x - mid.x, center(a).y - mid.y)
        const db = Math.hypot(center(b).x - mid.x, center(b).y - mid.y)
        return db < da ? b : a
      })
      return this.select(best.id)
    }
    const o = center(cur)
    let best: CardView | undefined
    let bestScore = Infinity
    for (const c of candidates) {
      if (c === cur) continue
      const p = center(c)
      const vx = p.x - o.x
      const vy = p.y - o.y
      const along = vx * dx + vy * dy
      if (along <= 4) continue
      const across = Math.abs(vx * dy - vy * dx)
      const score = along + across * 2.2
      if (score < bestScore) {
        bestScore = score
        best = c
      }
    }
    if (best) this.select(best.id)
  }

  visibleBounds(): Rect {
    return this.camera.visibleWorld()
  }
}
