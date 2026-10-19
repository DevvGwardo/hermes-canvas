import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { Backend } from "../src/app/backend"
import { Store } from "../src/app/store"
import { TilesView, gridFor, projectHue } from "../src/app/tiles"
import type { FormInfo, PermissionRequest, Session } from "../src/app/types"

// T29: the tiles view - the auto-layout grid kernel (gridFor/projectHue are
// pure) plus the Tile chrome and TilesView membership rules. FakeEl tree as
// in test/transcript-widgets.test.ts, extended with the surfaces tiles adds:
// dataset, a setProperty style bag, insertBefore, innerHTML that synthesizes
// span children (autoApproveToggle paints via innerHTML + querySelector),
// closest/matches, focus/blur no-ops and a fixed getBoundingClientRect.
//
// Membership contract pinned here: a session only lingers as "review" if it
// was ALREADY wanted (watched going live) when it finished - wants() checks
// seenHere, which sync() only populates for sessions it showed.

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
  hidden = false
  title = ""
  type = ""
  value: any = ""
  step = ""
  placeholder = ""
  checked = false
  rows = 0
  style = new FakeStyle()
  dataset: Record<string, string> = {}
  attrs: Record<string, string> = {}
  children: FakeEl[] = []
  parent: FakeEl | null = null
  handlers: Record<string, Array<(e: any) => void>> = {}
  scrollTop = 0
  scrollHeight = 0
  clientHeight = 0
  private html = ""

  constructor(tag: string) {
    this.tag = tag
  }

  get firstElementChild(): FakeEl | null {
    return this.children[0] ?? null
  }

  get innerHTML() {
    return this.html
  }

  set innerHTML(v: string) {
    this.html = v
    for (const c of this.children) c.parent = null
    this.children = []
    // naive span harvester: enough for autoApproveToggle and counts strings
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

  append(...nodes: any[]) {
    for (const n of nodes) {
      const el = typeof n === "string" ? new FakeEl("#text") : n
      el.parent?.removeChild(el)
      el.parent = this
      this.children.push(el)
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

  replaceWith(el: FakeEl) {
    const p = this.parent
    if (!p) return
    const i = p.children.indexOf(this)
    el.parent?.removeChild(el)
    p.children[i] = el
    el.parent = p
    this.parent = null
  }

  replaceChildren(...nodes: any[]) {
    for (const c of this.children) c.parent = null
    this.children = []
    this.append(...nodes)
  }

  insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
    node.parent?.removeChild(node)
    node.parent = this
    if (!ref) {
      this.children.push(node)
      return node
    }
    const i = this.children.indexOf(ref)
    if (i >= 0) this.children.splice(i, 0, node)
    else this.children.push(node)
    return node
  }

  setAttribute(k: string, v: string) {
    this.attrs[k] = v
  }

  addEventListener(type: string, fn: (e: any) => void) {
    ;(this.handlers[type] ??= []).push(fn)
  }

  fire(type: string, extra: Record<string, any> = {}) {
    const ev = { preventDefault() {}, stopPropagation() {}, target: this, ...extra }
    for (const fn of this.handlers[type] ?? []) fn(ev)
  }

  focus() {}
  blur() {}

  matches(sel: string) {
    return sel.startsWith(".") ? this.className.split(/\s+/).includes(sel.slice(1)) : this.tag === sel
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
    return { width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }
  }

  getContext() {
    return new Proxy({}, { get: () => () => {} })
  }
}

function find(el: FakeEl, pred: (e: FakeEl) => boolean): FakeEl | undefined {
  for (const c of el.children) {
    if (pred(c)) return c
    const hit = find(c, pred)
    if (hit) return hit
  }
  return undefined
}

function textOf(el: FakeEl): string {
  let s = el.textContent
  for (const c of el.children) s += textOf(c)
  return s
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

let saved: Record<string, unknown> = {}
let ls = new Map<string, string>()
let intervals: Array<{ ms: number; fn: () => void }> = []
const realSetInterval = globalThis.setInterval

beforeEach(() => {
  for (const k of ["document", "window", "localStorage", "ResizeObserver", "setInterval", "requestAnimationFrame"])
    saved[k] = (globalThis as any)[k]
  ;(globalThis as any).window = { devicePixelRatio: 1 }
  ;(globalThis as any).requestAnimationFrame = () => 0 // spinner arms only; never driven here
  ;(globalThis as any).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => {
      const n = new FakeEl("#text")
      n.textContent = t
      return n
    },
    documentElement: new FakeEl("html"),
    body: new FakeEl("body"), // toast() hosts lazily on first use
  }
  ls = new Map()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
    setItem: (k: string, v: string) => void ls.set(k, String(v)),
    removeItem: (k: string) => void ls.delete(k),
  }
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  intervals = []
  ;(globalThis as any).setInterval = (fn: () => void, ms: number) => {
    intervals.push({ ms, fn })
    return intervals.length
  }
})

afterEach(() => {
  for (const k of Object.keys(saved)) (globalThis as any)[k] = saved[k]
  ;(globalThis as any).setInterval = realSetInterval
})

const NOW = Date.now()
const mk = (id: string, time: Record<string, number>, over: Record<string, any> = {}): Session =>
  ({
    id,
    projectID: "p1",
    cost: 0,
    tokens: {} as any,
    outcome: "succeeded",
    time: { created: NOW - 3_600_000, updated: NOW - 60_000, ...time },
    location: { directory: "/home/t/a" },
    ...over,
  }) as unknown as Session

const permReq = (sessionID: string): PermissionRequest => ({ id: `p_${sessionID}`, sessionID, action: "bash.run", resources: [] })
const qForm = (sessionID: string): FormInfo => ({ id: `f_${sessionID}`, sessionID, title: "?", fields: [] })

function tilesBackend(sessions: Session[]) {
  const prompts: Array<{ id: string; text?: string; delivery?: string }> = []
  let failPrompt = false
  const backend = {
    listProjects: async () => [],
    listSessions: async () => sessions,
    active: async () => new Set<string>(),
    messages: async () => ({ data: [] }),
    inbox: async () => [],
    markViewed: async () => {},
    prompt: async (id: string, msg: { text?: string; delivery?: string }) => {
      if (failPrompt) throw new Error("nope")
      prompts.push({ id, ...msg })
    },
    interrupt: async () => {},
    replyPermission: async () => {},
    replyForm: async () => {},
    cancelForm: async () => {},
    cancelInbox: async () => {},
    setInboxDelivery: async () => {},
    setSessionPermissions: async () => {},
  }
  return { backend: backend as unknown as Backend, prompts, setFailPrompt: (f: boolean) => void (failPrompt = f) }
}

function baseSessions(): Session[] {
  return [
    mk("s1", { updated: NOW - 1_000 }), // running
    mk("s2", { updated: NOW - 2_000, idle: NOW - 2_000 }), // permission ask
    mk("s3", { updated: NOW - 2_000, idle: NOW - 2_000 }), // question form
    mk("s4", { updated: NOW - 1_000 }), // starts running; tests finish it mid-watch
    mk("s5", { updated: NOW - 300_000, idle: NOW - 300_000, viewed: NOW - 1_000 }), // viewed -> done
    mk("s6", { updated: NOW - 1_000 }, { parentID: "s1" }), // running subagent of s1
  ]
}

async function viewFixture(opts: { active?: string[]; perms?: string[]; forms?: string[] } = {}) {
  const sessions = baseSessions()
  const b = tilesBackend(sessions)
  const store = new Store(b.backend)
  await store.reload()
  for (const id of opts.perms ?? ["s2"]) store.permissions.set(id, [permReq(id)])
  for (const id of opts.forms ?? ["s3"]) store.forms.set(id, [qForm(id)])
  const active = opts.active ?? ["s1", "s4", "s6"]
  b.backend.active = async () => new Set(active)
  await store["syncActive"]()
  const host = new FakeEl("div")
  const handlerCalls = { openOnCanvas: [] as string[], newSession: 0, closed: 0 }
  const view = new TilesView(host as any, store, b.backend, {
    openOnCanvas: (id: string) => handlerCalls.openOnCanvas.push(id),
    newSession: () => handlerCalls.newSession++,
    closed: () => handlerCalls.closed++,
  })
  const grid = view["grid"] as unknown as FakeEl
  const tiles = view["tiles"] as unknown as Map<string, any>
  return { view, store, host, grid, tiles, handlerCalls, backend: b.backend, prompts: b.prompts, setFailPrompt: b.setFailPrompt }
}

// ---- tile element helpers (Tile.root etc are DOM at runtime, FakeEl here) ----
const tileOf = (tiles: Map<string, any>, id: string) => tiles.get(id)!
const statusElOf = (tiles: Map<string, any>, id: string) => find(tileOf(tiles, id).root as unknown as FakeEl, (e) => e.className.includes("tile-status"))!
const labelOf = (tiles: Map<string, any>, id: string) => find(statusElOf(tiles, id), (e) => e.className.includes("label"))!
const btnBy = (tiles: Map<string, any>, id: string, title: string) =>
  find(tileOf(tiles, id).root as unknown as FakeEl, (e) => e.tag === "button" && e.title.startsWith(title))!
const inputOf = (tiles: Map<string, any>, id: string) => find(tileOf(tiles, id).root as unknown as FakeEl, (e) => e.tag === "textarea")!

/** Make a watched session finish: set idle now, drop it AND its subagents from
 * the active set (a parent is "working" while any child runs), then refresh
 * tile chrome via the real 30s tick path and re-evaluate membership. */
async function finish(ctx: Awaited<ReturnType<typeof viewFixture>>, id: string) {
  const s = ctx.store.sessions.get(id)!
  s.time.idle = Date.now()
  const gone = new Set([id, ...[...ctx.store.sessions.values()].filter((x) => x.parentID === id).map((x) => x.id)])
  ctx.backend.active = async () => new Set(["s1", "s4", "s6"].filter((a) => !gone.has(a)))
  await ctx.store["syncActive"]()
  intervals.at(-1)!.fn() // the periodic tick re-renders tile labels
  ctx.view["sync"]()
}

describe("gridFor — the layout kernel", () => {
  it("zero tiles is a single empty cell", () => {
    expect(gridFor(0, 1600, 900)).toEqual({ cols: 1, rows: 1, rowH: 900 })
    expect(gridFor(-3, 1600, 900)).toEqual({ cols: 1, rows: 1, rowH: 900 })
  })

  it("four tiles in a wide area settle at 2x2", () => {
    const g = gridFor(4, 1600, 900)
    expect(g.cols).toBe(2)
    expect(g.rows).toBe(2)
    expect(g.rowH).toBe(445) // (900 - GAP) / 2
  })

  it("six tiles prefer three columns over a cramped third row", () => {
    const g = gridFor(6, 1600, 900)
    expect(g.cols).toBe(3)
    expect(g.rows).toBe(2)
  })

  it("too narrow for two tiles falls back to a single column, rowH floored at the minimum", () => {
    const tall = gridFor(3, 700, 900)
    expect(tall.cols).toBe(1)
    expect(tall.rows).toBe(3)
    const short = gridFor(3, 700, 400)
    expect(short.cols).toBe(1)
    expect(short.rowH).toBe(300) // MIN_TILE_H floor, never the 126px the area implies
  })

  it("holds its invariants across the size matrix", () => {
    for (const n of [1, 2, 3, 5, 8]) {
      for (const w of [700, 1200, 1600, 2400]) {
        for (const hgt of [400, 700, 1000]) {
          const g = gridFor(n, w, hgt)
          expect(g.rows).toBe(Math.ceil(n / g.cols))
          expect(g.rowH).toBeGreaterThanOrEqual(300)
          if (g.cols > 1) expect((w - 10 * (g.cols - 1)) / g.cols).toBeGreaterThanOrEqual(360)
        }
      }
    }
  })
})

describe("projectHue", () => {
  it("is stable, in range, and key-sensitive", () => {
    expect(projectHue("hermes-canvas")).toBe(projectHue("hermes-canvas"))
    for (const k of ["a", "alpha", "hermes-canvas", ""]) {
      const h = projectHue(k)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
    }
    expect(projectHue("alpha")).not.toBe(projectHue("beta"))
  })
})

describe("TilesView — open/close and membership", () => {
  it("open builds tiles for wanted sessions; close destroys them and reports back", async () => {
    const { view, grid, handlerCalls, tiles } = await viewFixture()
    view.open()
    await flush()
    expect(view.isOpen).toBe(true)
    expect([...tiles.keys()].sort()).toEqual(["s1", "s2", "s3", "s4"]) // s5 done, s6 subagent
    expect(grid.children.length).toBe(4)

    view.close()
    expect(view.isOpen).toBe(false)
    expect(tiles.size).toBe(0)
    expect(grid.children.length).toBe(0) // live transcripts dropped while hidden
    expect(handlerCalls.closed).toBe(1)
    expect(view.maximized).toBeUndefined()
  })

  it("subagents stay out until the Subagents toggle lets them in, and the choice persists", async () => {
    const { view, tiles } = await viewFixture()
    view.open()
    await flush()
    expect(tiles.has("s6")).toBe(false)
    const box = find(view.el as unknown as FakeEl, (e) => e.tag === "input")!
    box.checked = true
    box.fire("change")
    await flush()
    expect(tiles.has("s6")).toBe(true)
    expect(ls.get("occ.tiles.subagents")).toBe("true")
  })

  it("dismissing a running tile hides it until its next run", async () => {
    const ctx = await viewFixture()
    const { view, store, tiles, grid } = ctx
    view.open()
    await flush()
    view.dismiss("s1")
    await flush()
    expect(tiles.has("s1")).toBe(false)

    // finishes while hidden -> still gone (dismissed-while-running never lingers)
    await finish(ctx, "s1")
    expect(tiles.has("s1")).toBe(false)

    // next run brings it back
    store.running.add("s1")
    view["sync"]()
    expect(tiles.has("s1")).toBe(true)
    expect(grid.children.length).toBeGreaterThan(0)
  })

  it("pinning keeps a finished session; unpinning drops it; pins persist", async () => {
    const { view, tiles } = await viewFixture()
    view.open()
    await flush()
    expect(tiles.has("s5")).toBe(false)
    view.togglePin("s5")
    await flush()
    expect(tiles.has("s5")).toBe(true)
    expect(JSON.parse(ls.get("occ.tiles.pins")!)).toEqual(["s5"])
    view.togglePin("s5")
    await flush()
    expect(tiles.has("s5")).toBe(false)
  })

  it("corrupt pins or an unwritable store never break the view", async () => {
    ls.set("occ.tiles.pins", "{corrupt") // load() falls back on a parse error
    const { view, tiles } = await viewFixture()
    view.open()
    await flush()
    expect(view["pins"]).toEqual(new Set())

    ;(globalThis as any).localStorage.setItem = () => {
      throw new Error("quota") // private mode / full disk
    }
    view.togglePin("s5") // save() swallows it
    await flush()
    expect(tiles.has("s5")).toBe(true) // the pin still applied in memory
  })

  it("a watched session lingers as review only until it is viewed elsewhere", async () => {
    const ctx = await viewFixture()
    const { view, store, tiles } = ctx
    view.open()
    await flush()
    expect(tiles.has("s4")).toBe(true) // watched it working

    await finish(ctx, "s4")
    expect(tiles.has("s4")).toBe(true) // stays as review while unseen
    expect(textOf(statusElOf(tiles, "s4"))).toContain("Finished")

    store.markViewed("s4") // read on another surface
    view["sync"]()
    expect(tiles.has("s4")).toBe(false)
    expect(view.liveCount()).toBe(3) // s1 working + s2/s3 needs-you
  })

  it("an already-finished session never appears unwatched, even while fresh", async () => {
    const ctx = await viewFixture({ active: ["s1", "s6"] }) // s4 not running at open
    const { view, tiles } = ctx
    view.open()
    await flush()
    expect(tiles.has("s4")).toBe(false) // never seen here -> not wanted
  })

  it("counts render with the needs-you pluralisation in both forms", async () => {
    const ctx = await viewFixture()
    const { view, store, tiles } = ctx
    view.open()
    await flush()
    const counts = find(view.el as unknown as FakeEl, (e) => e.className.includes("tiles-counts"))!
    expect(counts.innerHTML).toContain("2 need you") // s2 permission + s3 question
    expect(counts.innerHTML).toContain("2 working")

    store.permissions.delete("s2") // one ask answered elsewhere
    view["sync"]()
    expect(counts.innerHTML).toContain("1 needs you") // singular
    expect(view.liveCount()).toBe(tiles.size)
  })

  it("an area with no wanted sessions shows the empty state", async () => {
    const { view, store } = await viewFixture({ active: [], perms: [], forms: [] })
    // every fixture session that could linger has been read
    for (const id of ["s2", "s3"]) store.markViewed(id)
    view.open()
    await flush()
    const empty = find(view.el as unknown as FakeEl, (e) => e.className.includes("tiles-empty"))!
    expect(view["tiles"].size).toBe(0)
    expect(empty.hidden).toBe(false)
    expect(empty.innerHTML).toContain("Nothing running right now")
  })
})

describe("TilesView — store card events", () => {
  // T36: the store.on cards listener (tiles.ts 312-326). Drive the
  // registered listener directly: the flush batching is store-side and
  // covered there, while the store's pending real timers would otherwise
  // contaminate a fake-timer advance.
  const fireCards = (store: Store, ...ids: string[]) => {
    for (const l of store["listeners"]) l.cards?.(new Set(ids))
  }

  it("a closed view ignores card events entirely", async () => {
    const { view, store, tiles, grid } = await viewFixture()
    fireCards(store, "s1") // never opened
    await flush()
    expect(view.isOpen).toBe(false)
    expect(tiles.size).toBe(0)
    expect(grid.children.length).toBe(0)
  })

  it("content touches refresh the tile chrome and counts without a re-sync", async () => {
    const ctx = await viewFixture()
    const { view, store, tiles, grid } = ctx
    view.open()
    await flush()
    const before = tileOf(tiles, "s1")
    const updates: string[] = []
    before.update = () => updates.push("s1") // spy on the chrome refresh
    let syncs = 0
    let counts = 0
    const origSync = view["sync"]
    const origCounts = view["renderCounts"]
    view["sync"] = (...a: any[]) => {
      syncs++
      return (origSync as any).apply(view, a)
    }
    view["renderCounts"] = (...a: any[]) => {
      counts++
      return (origCounts as any).apply(view, a)
    }

    fireCards(store, "s1")
    await flush()
    expect(updates).toEqual(["s1"]) // touched branch: chrome refreshed...
    expect(syncs).toBe(0) // ...but no structural re-sync...
    expect(counts).toBe(1) // ...just the header counts
    expect(tiles.get("s1")).toBe(before) // same tile instance, grid untouched
    expect(grid.children.length).toBe(4)
  })

  it("membership flips route through a full re-sync", async () => {
    const ctx = await viewFixture()
    const { view, store, tiles, grid } = ctx
    view.open()
    await flush()
    expect(tiles.has("s4")).toBe(true)

    await finish(ctx, "s4") // review linger: still wanted while unseen
    expect(tiles.has("s4")).toBe(true)

    store.markViewed("s4") // read elsewhere -> no longer wanted, tile lingers stale
    fireCards(store, "s4")
    await flush()
    expect(tiles.has("s4")).toBe(false) // membership mismatch: full re-sync drops it
    expect(grid.children.length).toBe(3)

    // Gain the other way: unseen again (seenHere survives), wanted on re-eval.
    store.sessions.get("s4")!.time.viewed = undefined
    fireCards(store, "s4")
    await flush()
    expect(tiles.has("s4")).toBe(true)
    expect(grid.children.length).toBe(4)
  })
})

describe("TilesView — remaining interaction seams", () => {
  // T38: the last uncovered tiles branches - button click wiring, composer
  // autosize, idempotent pin(), and the openOnCanvas handoff.

  it("tile button clicks stop propagation and run their action", async () => {
    const ctx = await viewFixture()
    const { view, tiles } = ctx
    view.open()
    await flush()
    const maxBtn = btnBy(tiles, "s1", "Maximize")
    let stopped = 0
    maxBtn.fire("click", { stopPropagation: () => stopped++ })
    expect(stopped).toBe(1) // the click must not reach the card behind the button
    expect(view.maximized).toBe("s1")
    maxBtn.fire("click", { stopPropagation: () => stopped++ })
    expect(stopped).toBe(2)
    expect(view.maximized).toBeUndefined() // and it toggles back off
  })

  it("the composer autosizes its height, capped at 120px", async () => {
    const ctx = await viewFixture()
    const { view, tiles } = ctx
    view.open()
    await flush()
    const input = inputOf(tiles, "s1")
    input.scrollHeight = 40
    input.fire("input")
    expect(input.style.height).toBe("40px")
    input.scrollHeight = 500
    input.fire("input")
    expect(input.style.height).toBe("120px") // never grows past the cap
  })

  it("pin() pins once and never toggles back", async () => {
    const ctx = await viewFixture()
    const { view, tiles } = ctx
    view.open()
    await flush()
    expect(tiles.has("s5")).toBe(false)
    view.pin("s5")
    await flush()
    expect(tiles.has("s5")).toBe(true)
    view.pin("s5") // second call is a no-op, not an unpin
    await flush()
    expect(tiles.has("s5")).toBe(true)
    expect(JSON.parse(ls.get("occ.tiles.pins")!)).toEqual(["s5"])
  })

  it("openOnCanvas hands the session back and closes the tiles view", async () => {
    const ctx = await viewFixture()
    const { view, handlerCalls } = ctx
    view.open()
    await flush()
    expect(view.isOpen).toBe(true)
    view.openOnCanvas("s2")
    expect(view.isOpen).toBe(false)
    expect(handlerCalls.openOnCanvas).toEqual(["s2"])
  })
})

describe("Tile — chrome and composer", () => {
  it("status labels and affordances follow the store status", async () => {
    const ctx = await viewFixture()
    const { view, tiles } = ctx
    view.open()
    await flush()

    expect(textOf(statusElOf(tiles, "s2"))).toContain("Needs permission")
    expect(textOf(statusElOf(tiles, "s3"))).toContain("Waiting for your answer")
    expect(btnBy(tiles, "s2", "Interrupt").hidden).toBe(false) // live -> stop offered
    expect(inputOf(tiles, "s2").placeholder).toBe("Steer…")
    expect(tileOf(tiles, "s2").root.className).not.toContain("auto")

    await finish(ctx, "s4")
    expect(textOf(statusElOf(tiles, "s4"))).toMatch(/Finished · /)
    expect(tileOf(tiles, "s4").root.dataset.status).toBe("review")
    expect(btnBy(tiles, "s4", "Interrupt").hidden).toBe(true)
    expect(inputOf(tiles, "s4").placeholder).toBe("Reply…")
  })

  it("a working tile shows the spinner, the activity label, and refreshes on the 30s tick", async () => {
    const { view, store, tiles } = await viewFixture()
    view.open()
    await flush()
    expect(tileOf(tiles, "s1").root.dataset.status).toBe("working")
    expect(find(statusElOf(tiles, "s1"), (e) => e.tag === "canvas")).toBeDefined() // spinner
    expect(textOf(statusElOf(tiles, "s1"))).toContain("Working…") // activityLabel fallback

    store["activity"].set("s1", "Reading file")
    const tick = intervals.at(-1)!
    expect(tick.ms).toBe(30_000)
    tick.fn() // the periodic refresh all tiles get while open
    expect(textOf(labelOf(tiles, "s1"))).toContain("Reading file")
  })

  it("Enter steers while running and replies otherwise; Tab queues; empties are ignored", async () => {
    const { view, tiles, prompts } = await viewFixture()
    view.open()
    await flush()

    const runningInput = inputOf(tiles, "s1")
    runningInput.value = "hello there"
    runningInput.fire("keydown", { key: "Enter", shiftKey: false })
    await flush()
    expect(prompts).toEqual([{ id: "s1", text: "hello there", delivery: "steer" }])
    expect(runningInput.value).toBe("")
    expect(textOf(tileOf(tiles, "s1").transcript.list as unknown as FakeEl)).toContain("hello there") // optimistic row

    const idleInput = inputOf(tiles, "s2")
    idleInput.value = "done yet?"
    idleInput.fire("keydown", { key: "Enter", shiftKey: false })
    await flush()
    expect(prompts[1]!.delivery).toBeUndefined() // not running -> plain reply

    idleInput.value = "queue me"
    idleInput.fire("keydown", { key: "Tab", shiftKey: false })
    await flush()
    expect(prompts[2]).toEqual({ id: "s2", text: "queue me", delivery: "queue" })

    idleInput.value = "   "
    idleInput.fire("keydown", { key: "Enter", shiftKey: false })
    await flush()
    expect(prompts.length).toBe(3) // whitespace never sends

    idleInput.value = "shift enter"
    idleInput.fire("keydown", { key: "Enter", shiftKey: true })
    await flush()
    expect(prompts.length).toBe(3)

    idleInput.fire("keydown", { key: "Escape" }) // blur no-op, must not throw
  })

  it("a failed send drops the pending row and restores the draft", async () => {
    const { view, tiles, setFailPrompt } = await viewFixture()
    view.open()
    await flush()
    const input = inputOf(tiles, "s2")
    input.value = "draft"
    setFailPrompt(true)
    input.fire("keydown", { key: "Enter", shiftKey: false })
    await flush()
    expect(input.value).toBe("draft") // text put back for a retry
    expect(textOf(tileOf(tiles, "s2").transcript.list as unknown as FakeEl)).not.toContain("draft") // row withdrawn
  })

  it("maximize dims the others and swaps the button; header dblclick toggles, buttons do not", async () => {
    const { view, tiles, grid } = await viewFixture()
    view.open()
    await flush()

    view.toggleMax("s1")
    expect(view.maximized).toBe("s1")
    expect(grid.style.gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))")
    expect(tileOf(tiles, "s2").root.classList.contains("off")).toBe(true)
    expect(tileOf(tiles, "s1").root.classList.contains("off")).toBe(false)
    expect(btnBy(tiles, "s1", "Restore").dataset.max).toBe("true")

    view.toggleMax("s1")
    expect(view.maximized).toBeUndefined()
    expect(grid.style.gridTemplateColumns).not.toBe("repeat(1, minmax(0, 1fr))")
    expect(btnBy(tiles, "s1", "Maximize").dataset.max).toBe("false")

    const head = find(tileOf(tiles, "s1").root as unknown as FakeEl, (e) => e.className.includes("tile-head"))!
    head.fire("dblclick", { target: head })
    expect(view.maximized).toBe("s1")
    head.fire("dblclick", { target: btnBy(tiles, "s1", "Restore") })
    expect(view.maximized).toBe("s1") // click landed on a button: no double-toggle
    view.toggleMax("s1")
  })
})
