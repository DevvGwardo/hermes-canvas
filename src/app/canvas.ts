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
  private result?: LayoutResult
  private layoutName: LayoutName = "tree"
  private query = ""
  private expanded?: string
  private needsLayout = true
  private firstLayout = true
  private heightsDirty = new Set<string>()
  private frameScheduled = false
  private lastFrame = performance.now()
  private cameraDirty = true
  private lastPreviewScan = 0
  private openId?: string
  private accentH = 0
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
    const ro = new ResizeObserver(() => {
      this.camera.setViewport(this.stage.clientWidth, this.stage.clientHeight)
      this.cameraDirty = true
      this.needsLayout = true
      this.kick()
    })
    ro.observe(this.stage)
    this.camera.setViewport(this.stage.clientWidth || innerWidth, this.stage.clientHeight || innerHeight)

    this.bindInput()

    store.on({
      structure: () => this.sync(),
      cards: (ids) => this.updateCards(ids),
    })
    setInterval(() => this.updateCards(new Set(this.cards.keys())), 30_000)
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
    this.relayout(!was || !next)
    if (!next) return
    // The server also searches content we haven't loaded into previews yet.
    const seq = ++this.remoteSeq
    this.store.backend
      .searchSessions(next)
      .then((found) => {
        if (seq !== this.remoteSeq || !found.length) return
        this.remoteHits = new Set(found.map((s) => s.id))
        // Older sessions outside the initial page join the canvas on demand.
        const missing = found.filter((s) => !this.store.sessions.has(s.id) && !s.time.archived)
        if (missing.length) this.store.addSessions(missing)
        this.relayout(true)
      })
      .catch(() => {})
  }

  get stackOpen() {
    return !!this.expanded
  }

  closeStack() {
    if (!this.expanded) return false
    const g = this.expanded
    this.expanded = undefined
    this.relayout(false)
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
    const c = this.cards.get(id)
    const t = c?.target
    if (!c || !t) return
    this.camera.animateTo(t.x + CARD_W / 2, t.y + c.h / 2, zoom ?? Math.max(this.camera.z, 0.9))
  }

  fitAll() {
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

  private sync() {
    const groups = this.store.groups()
    this.groupsCache = groups
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
    for (const [id, c] of this.cards) {
      if (seen.has(id)) continue
      c.root.remove()
      this.cards.delete(id)
      if (this.selected === id) this.selected = undefined
    }
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
    }
    ;(c as any).fresh = true
    this.world.append(root)
    this.cards.set(id, c)
    return c
  }

  private updateCards(ids: Set<string>) {
    const now = Date.now()
    for (const id of ids) {
      const c = this.cards.get(id)
      if (!c?.els) continue
      const before = c.root.dataset.status
      updateSessionCard(c.els, this.store, id, now)
      this.heightsDirty.add(id)
      // A status change reorders its project (and the filtered grid).
      if (before !== undefined && before !== c.root.dataset.status) {
        this.groupsCache = this.store.groups()
        this.needsLayout = true
      }
    }
    this.kick()
  }

  private measure() {
    if (!this.heightsDirty.size) return
    let changed = false
    for (const id of this.heightsDirty) {
      const c = this.cards.get(id)
      if (!c || c.kind !== "session") continue
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
    ;(this as any).fitAfterLayout = fitCamera || (this as any).fitAfterLayout
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
      if ((c as any).fresh || this.firstLayout) {
        ;(c as any).fresh = false
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
    this.renderLabels()
    this.camera.setBounds(this.result.bounds)

    if (this.firstLayout && this.groupsCache.length) {
      this.firstLayout = false
      this.initialCamera()
    } else if ((this as any).fitAfterLayout) {
      const b = this.query ? (this.result.groups.get("__search") ?? this.result.bounds) : this.result.bounds
      this.camera.fit(b, 72, 1)
    }
    ;(this as any).fitAfterLayout = false
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
      e.querySelector(".count")!.textContent = l.sub ?? ""
      this.renderLabelMarks(e.querySelector(".marks")!, l.key)
      e.style.width = `${l.w}px`
      e.style.transform = `translate(${l.x}px, ${l.y}px)`
      e.classList.remove("gone")
    }
    for (const [k, e] of this.labels) {
      if (seen.has(k)) continue
      e.classList.add("gone")
      setTimeout(() => {
        if (e.classList.contains("gone")) {
          e.remove()
          this.labels.delete(k)
        }
      }, 400)
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
    if (this.frameScheduled) return
    this.frameScheduled = true
    requestAnimationFrame((t) => this.frame(t))
  }

  private frame(now: number) {
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
    stage.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault()
        const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1
        const r = stage.getBoundingClientRect()
        if (e.ctrlKey || e.metaKey) {
          this.camera.zoomAt(Math.exp(-e.deltaY * k * 0.0105), e.clientX - r.left, e.clientY - r.top)
        } else {
          this.camera.panBy(e.deltaX * k, e.deltaY * k)
        }
      },
      { passive: false },
    )

    // Safari trackpad pinch.
    let gestureScale = 1
    stage.addEventListener("gesturestart", (e: any) => {
      e.preventDefault()
      gestureScale = 1
    })
    stage.addEventListener("gesturechange", (e: any) => {
      e.preventDefault()
      const r = stage.getBoundingClientRect()
      this.camera.zoomAt(e.scale / gestureScale, e.clientX - r.left, e.clientY - r.top)
      gestureScale = e.scale
    })

    const pointers = new Map<number, { x: number; y: number }>()
    let drag:
      | { id: number; x0: number; y0: number; x: number; y: number; panning: boolean; samples: Array<{ x: number; y: number; t: number }> }
      | undefined
    let pinch: { d: number; mx: number; my: number } | undefined

    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
        drag = undefined
        this.camera.hold()
        return
      }
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

    stage.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const r = stage.getBoundingClientRect()
        this.camera.panBy(pinch.mx - mx, pinch.my - my)
        this.camera.zoomAt(d / pinch.d, mx - r.left, my - r.top)
        pinch = { d, mx, my }
        return
      }
      if (!drag || drag.id !== e.pointerId) return
      if (!drag.panning && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 5) {
        drag.panning = true
        stage.setPointerCapture(e.pointerId)
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
      pointers.delete(e.pointerId)
      if (pinch) {
        if (pointers.size < 2) {
          pinch = undefined
          this.camera.release(0, 0)
        }
        return
      }
      if (!drag || drag.id !== e.pointerId) return
      const d = drag
      drag = undefined
      stage.classList.remove("grabbing")
      if (d.panning) {
        const a = d.samples[0]
        const b = d.samples[d.samples.length - 1]
        const dt = Math.max(16, b.t - a.t) / 1000
        const stale = performance.now() - b.t > 80
        this.camera.release(stale ? 0 : (a.x - b.x) / dt, stale ? 0 : (a.y - b.y) / dt)
        return
      }
      if (e.type === "pointercancel") return
      const target = (e.target as HTMLElement).closest<HTMLElement>(".card")
      if (target && !target.classList.contains("inert")) this.activate(target.dataset.id!)
      else {
        const lbl = (e.target as HTMLElement).closest<HTMLElement>(".group-label")
        if (lbl?.dataset.group && this.layoutName === "fold" && !this.query) this.openStack(lbl.dataset.group)
      }
    }
    stage.addEventListener("pointerup", end)
    stage.addEventListener("pointercancel", end)

    stage.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".card")) return
      this.fitAll()
    })
  }

  activate(id: string) {
    const c = this.cards.get(id)
    if (!c) return
    this.select(id, false)
    if (c.kind === "new") return this.handlers.newSession(c.group)
    if (this.layoutName === "fold" && !this.query && this.expanded !== c.group) return this.openStack(c.group)
    this.handlers.open(id)
  }

  openStack(group: string) {
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
