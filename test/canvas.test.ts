import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Backend } from "../src/app/backend"
import { CanvasView } from "../src/app/canvas"
import { Store } from "../src/app/store"
import type { Session } from "../src/app/types"

class FakeStyle {
  [k: string]: any
  setProperty(k: string, v: string) {
    this[k] = v
  }
}

class FakeEl {
  tag: string
  className = ""
  textContent = ""
  title = ""
  tabIndex = 0
  clientWidth = 1200
  clientHeight = 800
  offsetHeight = 190
  scrollHeight = 40
  style = new FakeStyle()
  dataset: Record<string, string> = {}
  attrs: Record<string, string> = {}
  children: FakeEl[] = []
  parent: FakeEl | null = null
  handlers: Record<string, Array<(e: any) => void>> = {}
  captures: number[] = []
  private html = ""

  constructor(tag: string) {
    this.tag = tag
  }

  get isConnected(): boolean {
    let cur: FakeEl | null = this
    while (cur.parent) cur = cur.parent
    return cur.tag === "root"
  }

  get innerHTML() {
    return this.html
  }

  set innerHTML(v: string) {
    this.html = v
    for (const c of this.children) c.parent = null
    this.children = []
    for (const m of v.matchAll(/<span[^>]*class="([^"]*)"[^>]*>([^<]*)<\/span>/g)) {
      const s = new FakeEl("span")
      s.className = m[1]!
      s.textContent = m[2]!
      this.append(s)
    }
  }

  get classList() {
    const self = this
    return {
      add: (...cs: string[]) => {
        const s = new Set(self.className.split(/\s+/).filter(Boolean))
        for (const c of cs) s.add(c)
        self.className = [...s].join(" ")
      },
      remove: (...cs: string[]) => {
        const s = new Set(self.className.split(/\s+/).filter(Boolean))
        for (const c of cs) s.delete(c)
        self.className = [...s].join(" ")
      },
      toggle: (c: string, force?: boolean) => {
        const has = self.className.split(/\s+/).includes(c)
        const want = force === undefined ? !has : force
        if (want) self.classList.add(c)
        else self.classList.remove(c)
        return want
      },
      contains: (c: string) => self.className.split(/\s+/).includes(c),
    }
  }

  append(...nodes: FakeEl[]) {
    for (const n of nodes) {
      n.parent?.removeChild(n)
      n.parent = this
      this.children.push(n)
    }
  }

  removeChild(el: FakeEl) {
    const i = this.children.indexOf(el)
    if (i >= 0) this.children.splice(i, 1)
  }

  remove() {
    this.parent?.removeChild(this)
    this.parent = null
  }

  replaceChildren(...nodes: FakeEl[]) {
    for (const c of this.children) c.parent = null
    this.children = []
    this.append(...nodes)
  }

  setAttribute(k: string, v: string) {
    this.attrs[k] = v
  }

  addEventListener(type: string, fn: (e: any) => void) {
    ;(this.handlers[type] ??= []).push(fn)
  }

  removeEventListener(type: string, fn: (e: any) => void) {
    const list = this.handlers[type]
    if (!list) return
    const idx = list.indexOf(fn)
    if (idx >= 0) list.splice(idx, 1)
  }

  setPointerCapture(id: number) {
    this.captures.push(id)
  }

  fire(type: string, extra: Record<string, any> = {}) {
    const ev = { type, preventDefault() {}, stopPropagation() {}, target: this, ...extra }
    for (const fn of [...(this.handlers[type] ?? [])]) fn(ev)
  }

  matches(sel: string) {
    return sel.split(",").some((part) => {
      const s = part.trim()
      return s.startsWith(".") ? this.className.split(/\s+/).includes(s.slice(1)) : this.tag === s
    })
  }

  closest(sel: string): FakeEl | null {
    let n: FakeEl | null = this
    while (n) {
      if (n.matches(sel)) return n
      n = n.parent
    }
    return null
  }

  querySelector(sel: string): FakeEl | null {
    const cls = sel.startsWith(".") ? sel.slice(1) : sel
    for (const c of this.children) {
      if (c.className.split(/\s+/).includes(cls)) return c
      const hit = c.querySelector(sel)
      if (hit) return hit
    }
    return null
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }
  }

  getContext() {
    return new Proxy({}, { get: () => () => {} })
  }
}

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let rafQueue: Array<{ id: number; fn: (now: number) => void }> = []
let nextRafId = 1
let roCallbacks: Array<() => void> = []
let intervals: Array<{ id: number; ms: number; fn: () => void; cleared: boolean }> = []
let timeouts: Array<{ id: number; ms: number; fn: () => void; cleared: boolean }> = []
let windowHandlers: Record<string, Array<(e: any) => void>> = {}
let fakeNow = 10_000
const realNow = performance.now.bind(performance)

function flushRaf(now = fakeNow) {
  const q = rafQueue
  rafQueue = []
  for (const r of q) r.fn(now)
}

beforeEach(() => {
  for (const k of [
    "document",
    "window",
    "DOMRect",
    "ResizeObserver",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "setInterval",
    "clearInterval",
    "setTimeout",
    "clearTimeout",
    "innerWidth",
    "innerHeight",
  ]) {
    saved[k] = g[k]
  }
  fakeNow = 10_000
  performance.now = () => fakeNow
  rafQueue = []
  nextRafId = 1
  roCallbacks = []
  intervals = []
  timeouts = []
  windowHandlers = {}

  g.innerWidth = 1200
  g.innerHeight = 800
  g.document = { createElement: (tag: string) => new FakeEl(tag) }
  g.window = {
    devicePixelRatio: 1,
    addEventListener: (t: string, fn: (e: any) => void) => void (windowHandlers[t] ??= []).push(fn),
    removeEventListener: (t: string, fn: (e: any) => void) => {
      const l = windowHandlers[t]
      if (!l) return
      const i = l.indexOf(fn)
      if (i >= 0) l.splice(i, 1)
    },
  }
  g.DOMRect = class {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
    get left() {
      return this.x
    }
    get top() {
      return this.y
    }
  }
  g.ResizeObserver = class {
    constructor(cb: () => void) {
      roCallbacks.push(cb)
    }
    observe() {}
    disconnect() {}
  }
  g.requestAnimationFrame = (fn: (now: number) => void) => {
    const id = nextRafId++
    rafQueue.push({ id, fn })
    return id
  }
  g.cancelAnimationFrame = (id: number) => {
    rafQueue = rafQueue.filter((r) => r.id !== id)
  }
  g.setInterval = (fn: () => void, ms: number) => {
    const item = { id: intervals.length + 1, ms, fn, cleared: false }
    intervals.push(item)
    return item.id
  }
  g.clearInterval = (id: number) => {
    const item = intervals.find((x) => x.id === id)
    if (item) item.cleared = true
  }
  g.setTimeout = (fn: () => void, ms: number) => {
    const item = { id: timeouts.length + 1, ms, fn, cleared: false }
    timeouts.push(item)
    return item.id
  }
  g.clearTimeout = (id: number) => {
    const item = timeouts.find((x) => x.id === id)
    if (item) item.cleared = true
  }
})

afterEach(() => {
  performance.now = realNow
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete g[k]
    else g[k] = saved[k]
  }
})

const NOW = 1_700_000_000_000
const mk = (id: string, dir = "/repo/a", over: Record<string, any> = {}): Session =>
  ({
    id,
    projectID: dir,
    title: `Session ${id}`,
    cost: 0,
    tokens: {} as any,
    outcome: "succeeded",
    time: { created: NOW - 10_000, updated: NOW - 1_000, ...over.time },
    location: { directory: dir },
    ...over,
  }) as unknown as Session

async function setup(sessions: Session[], extra: Partial<Backend> = {}) {
  const opened: string[] = []
  const newSessions: string[] = []
  const selChanges: Array<string | undefined> = []
  const backend = {
    listProjects: async () => [],
    listSessions: async () => sessions,
    active: async () => new Set<string>(),
    messages: async () => ({ data: [] }),
    inbox: async () => [],
    markViewed: async () => {},
    searchSessions: async () => [],
    ...extra,
  } as unknown as Backend
  const store = new Store(backend)
  await store.reload()
  const host = new FakeEl("root")
  const view = new CanvasView(host as any, store, {
    open: (id) => opened.push(id),
    newSession: (g) => newSessions.push(g),
    selectionChanged: (id) => selChanges.push(id),
  })
  // Trigger initial structure sync manually (like store.start -> reload -> emit)
  view["sync"]()
  return { view, store, host, opened, newSessions, selChanges }
}

describe("CanvasView", () => {
  test("C7: cardRect, centerOn, fitAll, moveSelection work immediately before next rAF", async () => {
    const s1 = mk("s1", "/repo/a", { time: { created: NOW - 10_000, updated: NOW - 100 } })
    const s2 = mk("s2", "/repo/b", { time: { created: NOW - 10_000, updated: NOW - 200 } })
    const { view } = await setup([s1, s2])

    // Without running rAF yet, needsLayout is true; querying geometry must ensureLayout synchronously
    const rect = view.cardRect("s1")
    expect(rect).toBeDefined()
    expect(Number.isFinite(rect!.x) && rect!.width).toBeGreaterThan(0)

    view.moveSelection(1, 0)
    expect(view.selected).toBeDefined()

    view.centerOn("s2", 1.2)
    expect(view.camera.moving).toBe(true)

    view.fitAll()
    expect(view["result"]).toBeDefined()
    view.destroy()
  })

  test("C1: fold layout + statusFilter opens sessions instead of stacks and ignores bogus __search/missing stacks", async () => {
    const s1 = mk("s1", "/repo/a", { time: { created: NOW - 10_000, updated: NOW - 100 } })
    const s2 = mk("s2", "/repo/a", { time: { created: NOW - 10_000, updated: NOW - 200 } })
    const { view, store, opened } = await setup([s1, s2])
    view.setLayout("fold")
    flushRaf()

    store.running.add("s1")
    view.setStatusFilter("working")
    flushRaf()

    // Clicking the card in filtered fold mode opens the session rather than expanding a pile
    const cardEl = (view["cards"].get("s1")!.root as unknown as FakeEl)
    ;(view.stage as unknown as FakeEl).fire("pointerdown", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 50, clientY: 50 })
    ;(view.stage as unknown as FakeEl).fire("pointerup", { pointerId: 1, target: cardEl })
    expect(opened).toEqual(["s1"])
    expect(view.stackOpen).toBe(false)

    // Clicking __search label must not open a bogus stack
    const searchLbl = view["labels"].get("__search") as unknown as FakeEl
    expect(searchLbl).toBeDefined()
    ;(view.stage as unknown as FakeEl).fire("pointerdown", { pointerId: 2, button: 0, pointerType: "mouse", clientX: 50, clientY: 50 })
    ;(view.stage as unknown as FakeEl).fire("pointerup", { pointerId: 2, target: searchLbl })
    expect(view.stackOpen).toBe(false)

    view.setStatusFilter(undefined)
    flushRaf()
    view.openStack("does-not-exist")
    expect(view.stackOpen).toBe(false)

    // Valid stack open, then remove group -> stackOpen clears
    const groupKey = store.groups()[0]!.key
    view.openStack(groupKey)
    expect(view.stackOpen).toBe(true)
    store.sessions.delete("s1")
    store.sessions.delete("s2")
    store["rebuildChildren"]()
    view["sync"]()
    expect(view.stackOpen).toBe(false)
    view.destroy()
  })

  test("C2: pinch/pan transitions clear .grabbing, survive 0px pinch, 3rd finger, extreme wheel, and lost capture/blur", async () => {
    const s1 = mk("s1", "/repo/a")
    const s2 = mk("s2", "/repo/a")
    const { view } = await setup([s1, s2])
    flushRaf()
    const stage = view.stage as unknown as FakeEl

    // 1-finger pan -> 2-finger pinch must remove .grabbing
    stage.fire("pointerdown", { pointerId: 1, button: 0, pointerType: "touch", clientX: 100, clientY: 100 })
    stage.fire("pointermove", { pointerId: 1, pointerType: "touch", clientX: 120, clientY: 120 })
    expect(stage.classList.contains("grabbing")).toBe(true)

    stage.fire("pointerdown", { pointerId: 2, button: 0, pointerType: "touch", clientX: 200, clientY: 100 })
    expect(stage.classList.contains("grabbing")).toBe(false)

    // Coincident 0px move & 3rd finger must not poison zoom with NaN/Infinity
    stage.fire("pointermove", { pointerId: 2, pointerType: "touch", clientX: 120, clientY: 120 })
    stage.fire("pointerdown", { pointerId: 3, button: 0, pointerType: "touch", clientX: 400, clientY: 400 })
    stage.fire("pointerup", { pointerId: 1 }) // lifts finger 1 -> re-anchors fingers 2+3 without jump
    stage.fire("pointermove", { pointerId: 3, pointerType: "touch", clientX: 410, clientY: 400 })
    stage.fire("pointerup", { pointerId: 2 })
    stage.fire("pointerup", { pointerId: 3 })
    expect(Number.isFinite(view.camera.z)).toBe(true)
    expect(Number.isFinite(view.camera.cx)).toBe(true)
    expect(stage.classList.contains("grabbing")).toBe(false)

    // Extreme wheel ctrlKey deltaMode=2 & invalid Safari gesture scale do not produce NaN/0/Infinity
    stage.fire("wheel", { deltaMode: 2, deltaX: 0, deltaY: 1e9, ctrlKey: true, clientX: 500, clientY: 400 })
    stage.fire("wheel", { deltaMode: 2, deltaX: 0, deltaY: -1e9, ctrlKey: true, clientX: 500, clientY: 400 })
    stage.fire("gesturestart", {})
    stage.fire("gesturechange", { scale: 0, clientX: 500, clientY: 400 })
    stage.fire("gestureend", {})
    expect(Number.isFinite(view.camera.z) && view.camera.z > 0).toBe(true)

    // lostpointercapture & window blur clear active drag + camera hold
    stage.fire("pointerdown", { pointerId: 9, button: 0, pointerType: "mouse", clientX: 100, clientY: 100 })
    stage.fire("pointermove", { pointerId: 9, pointerType: "mouse", buttons: 1, clientX: 130, clientY: 130 })
    expect(stage.classList.contains("grabbing")).toBe(true)
    stage.fire("lostpointercapture", { pointerId: 9 })
    expect(stage.classList.contains("grabbing")).toBe(false)

    stage.fire("pointerdown", { pointerId: 10, button: 0, pointerType: "mouse", clientX: 100, clientY: 100 })
    stage.fire("pointermove", { pointerId: 10, pointerType: "mouse", buttons: 1, clientX: 130, clientY: 130 })
    for (const fn of windowHandlers.blur ?? []) fn({})
    expect(stage.classList.contains("grabbing")).toBe(false)
    expect(view.camera["holding"]).toBe(false)

    // dblclick on .group-label does not override fitAll; on empty stage it fits
    view.setLayout("fold")
    flushRaf()
    const gKey = view["groupsCache"][0]!.key
    const gLbl = view["labels"].get(gKey) as unknown as FakeEl
    let fitCalls = 0
    const origFit = view.fitAll.bind(view)
    view.fitAll = () => {
      fitCalls++
      origFit()
    }
    stage.fire("dblclick", { target: gLbl })
    expect(fitCalls).toBe(0)
    stage.fire("dblclick", { target: stage })
    expect(fitCalls).toBe(1)

    view.destroy()
  })

  test("C3: clearing query cancels stale in-flight searchSessions response", async () => {
    const s1 = mk("s1", "/repo/a")
    let resolveSearch!: (v: Session[]) => void
    const remote = mk("remote1", "/repo/remote")
    const { view, store } = await setup([s1], {
      searchSessions: () => new Promise<Session[]>((r) => (resolveSearch = r)),
    })
    flushRaf()

    view.setQuery("remote")
    view.setQuery("")
    resolveSearch([remote])
    await Promise.resolve()
    await Promise.resolve()

    expect(view["remoteHits"].size).toBe(0)
    expect(store.sessions.has("remote1")).toBe(false)
    view.destroy()
  })

  test("C4: overlapping .gone label timers never orphan newly re-created labels", async () => {
    const s1 = mk("s1", "/repo/a")
    const s2 = mk("s2", "/repo/b")
    const { view, store } = await setup([s1, s2])
    flushRaf()
    const gA = store.groups()[0]!.key
    const gB = store.groups()[1]!.key

    // Hide gA and gB via search -> one 400ms timer scheduled per hidden group label (2 total)
    view.setQuery("s2")
    flushRaf()
    expect(view["labels"].get(gA)?.classList.contains("gone")).toBe(true)
    expect(view["labels"].get(gB)?.classList.contains("gone")).toBe(true)
    const labelTimers1 = timeouts.filter((t) => !t.cleared && t.ms === 400)
    expect(labelTimers1.length).toBe(2)

    // Trigger another relayout while hidden -> must NOT schedule duplicate overlapping timers
    view.setQuery("s2 ") // same trimmed
    view.setQuery("s2x")
    flushRaf()
    const activeTimers = timeouts.filter((t) => !t.cleared && t.ms === 400)
    expect(activeTimers.length).toBe(2)

    // Restore gA & gB before timers fire -> cancels pending removal timers and removes .gone
    view.setQuery("")
    flushRaf()
    expect(activeTimers.every((t) => t.cleared)).toBe(true)
    expect(view["labels"].get(gA)?.classList.contains("gone")).toBe(false)
    expect(view["labels"].get(gB)?.classList.contains("gone")).toBe(false)

    // Even if an earlier hide cycle's timer expired and gA was later recreated, a stale callback cannot delete the new node.
    view.setQuery("s2")
    flushRaf()
    const gAOriginal = view["labels"].get(gA)
    const secondWave = timeouts.filter((t) => !t.cleared && t.ms === 400)
    expect(secondWave.length).toBe(2)
    for (const t of secondWave) t.fn()
    expect(view["labels"].has(gA)).toBe(false)
    view.setQuery("")
    flushRaf()
    const gARecreated = view["labels"].get(gA)
    expect(gARecreated).toBeDefined()
    expect(gARecreated).not.toBe(gAOriginal)
    for (const t of timeouts) t.fn()
    expect(view["labels"].get(gA)).toBe(gARecreated)
    expect(view["labels"].has(gB)).toBe(true)
    view.destroy()
  })

  test("C5, C6, C13, C10: filter/delete updates selection, ignores 0x0 resize, skips unchanged 30s height reads, destroy cleans up", async () => {
    const s1 = mk("s1", "/repo/a", { title: "Alpha" })
    const s2 = mk("s2", "/repo/a", { title: "Beta" })
    const { view, store, host, opened, selChanges } = await setup([s1, s2])
    flushRaf()

    // Select s1 then filter it out -> selection cleared + selectionChanged fired + activate blocked
    view.select("s1", false)
    expect(view.selected).toBe("s1")
    view.setQuery("Beta")
    flushRaf()
    expect(view.selected).toBeUndefined()
    expect(selChanges.at(-1)).toBeUndefined()
    view.activate("s1")
    expect(opened).toEqual([])

    view.setQuery("")
    flushRaf()

    // Deletion in sync() notifies selectionChanged(undefined)
    view.select("s1", false)
    store.sessions.delete("s1")
    store["rebuildChildren"]()
    view["sync"]()
    expect(view.selected).toBeUndefined()
    expect(selChanges.at(-1)).toBeUndefined()

    // C6: transient 0x0 resize does not clobber camera viewport
    ;(view.stage as unknown as FakeEl).clientWidth = 0
    ;(view.stage as unknown as FakeEl).clientHeight = 0
    roCallbacks[0]?.()
    expect(view.camera.viewport).toEqual({ w: 1200, h: 800 })

    // C13: 30s tick with unchanged card text leaves heightsDirty empty
    flushRaf()
    expect(view["heightsDirty"].size).toBe(0)
    const tick = intervals.find((x) => x.ms === 30_000)!
    tick.fn()
    expect(view["heightsDirty"].size).toBe(0)

    // C10: destroy() clears listeners, intervals, timers, and removes stage
    const storeListenersBefore = store["listeners"].size
    view.destroy()
    expect(store["listeners"].size).toBe(storeListenersBefore - 1)
    expect(tick.cleared).toBe(true)
    expect(host.children.length).toBe(0)
  })

  test("public helpers & cancel drag without fling: setLayout, filter, closeStack, setOpen, zoomBy, hasSession, visibleBounds", async () => {
    const s1 = mk("s1", "/repo/a", { title: "Alpha" })
    const s2 = mk("s2", "/repo/a", { title: "Beta" })
    const { view, store, host } = await setup([s1, s2])
    flushRaf()
    const gA = store.groups()[0]!.key

    expect(view.hasSession("s1")).toBe(true)
    expect(view.hasSession("missing")).toBe(false)
    expect(view.filter).toBeUndefined()
    view.setStatusFilter("done")
    expect(view.filter).toBe("done")
    view.setStatusFilter(undefined)

    view.setLayout("fold")
    flushRaf()
    view.openStack(gA)
    expect(view.stackOpen).toBe(true)
    expect(view.closeStack()).toBe(true)
    expect(view.stackOpen).toBe(false)
    expect(view.closeStack()).toBe(false)

    view.setOpen("s1")
    expect(view["cards"].get("s1")?.root.classList.contains("is-open")).toBe(true)
    expect(host.classList.contains("dimmed")).toBe(true)
    view.setOpen(undefined)
    expect(host.classList.contains("dimmed")).toBe(false)

    const z0 = view.camera.z
    view.zoomBy(1.2)
    expect(view.camera.z).toBeGreaterThan(z0)
    expect(view.visibleBounds().w).toBeGreaterThan(0)

    // pointercancel mid-pan stops without inertia fling
    const stage = view.stage as unknown as FakeEl
    stage.fire("pointerdown", { pointerId: 1, button: 0, pointerType: "touch", clientX: 200, clientY: 200 })
    stage.fire("pointermove", { pointerId: 1, button: 0, pointerType: "touch", clientX: 260, clientY: 240 })
    stage.fire("pointercancel", { pointerId: 1, button: 0, pointerType: "touch", clientX: 260, clientY: 240 })
    expect(view.camera["vx"]).toBe(0)
    expect(view.camera["vy"]).toBe(0)

    view.destroy()
  })
})
