import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import type { Backend } from "../src/app/backend"
import { SessionPanel } from "../src/app/panel"
import { Store } from "../src/app/store"
import type { Session } from "../src/app/types"

// T46: first coverage for SessionPanel (the expanded open session). No test
// imported src/app/panel.ts before this file, so the whole file was INVISIBLE
// to the lcov lane (unimported files are never instrumented). This pins the
// two catch bodies the iter-37 sweep surfaced as undriven - setAuto (panel.ts
// 413) and send (panel.ts 546) - plus the open baseline that makes those
// pins meaningful. The model-popover catch at 365 stays T43-blocked: the
// suite-warm models() cache can never reject in-suite.
//
// FakeEl as in test/tiles.test.ts. Fake timers because open() schedules stray
// timeouts (focus at 260ms, class cleanup at 90ms) whose callbacks would run
// against this file's RESTORED globals later in the shared process.
//
// The catch bodies also toast, but the toast text is unassertable from here:
// the toast host is a module-level cache bound to whichever file toasted
// first in the process (see STATE, iter 37). The swallows are pinned by the
// observable state instead.

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
  spellcheck = false
  contentEditable = ""
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
    // naive span harvester: enough for any innerHTML-painted chrome
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

  removeEventListener(type: string, fn?: (e: any) => void) {
    if (!fn) {
      delete this.handlers[type]
      return
    }
    this.handlers[type] = (this.handlers[type] ?? []).filter((h) => h !== fn)
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

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** Aggregate text a render test can assert on (textContent + children). */
function textOf(el: FakeEl): string {
  let s = el.textContent
  for (const c of el.children) s += textOf(c)
  return s
}

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

function panelBackend(sessions: Session[]) {
  const prompts: Array<{ id: string; text?: string; delivery?: string }> = []
  const permCalls: Array<{ id: string; rules: unknown }> = []
  const renames: Array<{ id: string; title: string }> = []
  const interrupts: string[] = []
  let failPrompt = false
  let failPerms = false
  const backend = {
    listProjects: async () => [],
    listSessions: async () => sessions,
    active: async () => new Set<string>(),
    messages: async () => ({
      data: [{ type: "user", id: "m1", time: { created: NOW - 60_000 }, text: "hello" }],
    }),
    inbox: async () => [],
    markViewed: async () => {},
    prompt: async (id: string, msg: { text?: string; delivery?: string }) => {
      if (failPrompt) throw new Error("nope")
      prompts.push({ id, ...msg })
    },
    interrupt: async (id: string) => {
      interrupts.push(id)
    },
    replyPermission: async () => {},
    replyForm: async () => {},
    cancelForm: async () => {},
    cancelInbox: async () => {},
    setInboxDelivery: async () => {},
    setSessionPermissions: async (id: string, rules: unknown) => {
      if (failPerms) throw new Error("denied")
      permCalls.push({ id, rules })
    },
    rename: async (id: string, title: string) => {
      renames.push({ id, title })
    },
  }
  return {
    backend: backend as unknown as Backend,
    prompts,
    permCalls,
    renames,
    interrupts,
    setFailPrompt: (f: boolean) => void (failPrompt = f),
    setFailPerms: (f: boolean) => void (failPerms = f),
  }
}

let saved: Record<string, unknown> = {}
let clips: string[] = []

beforeEach(() => {
  jest.useFakeTimers() // keeps open()'s stray focus/cleanup timeouts inert
  clips = []
  for (const k of ["document", "window", "localStorage", "requestAnimationFrame", "matchMedia", "DOMRect", "innerWidth", "innerHeight", "navigator"])
    saved[k] = (globalThis as any)[k]
  ;(globalThis as any).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => {
      const n = new FakeEl("#text")
      n.textContent = t
      return n
    },
    body: new FakeEl("body"), // toast() hosts lazily if this file is first
    documentElement: new FakeEl("html"),
    activeElement: null,
    getSelection: () => ({ selectAllChildren: () => {} }),
  }
  ;(globalThis as any).window = { devicePixelRatio: 1, addEventListener: () => {} }
  ;(globalThis as any).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  }
  ;(globalThis as any).requestAnimationFrame = () => 0
  ;(globalThis as any).matchMedia = () => ({ matches: false })
  ;(globalThis as any).DOMRect = class {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
    get left() { return this.x }
    get top() { return this.y }
    get right() { return this.x + this.width }
    get bottom() { return this.y + this.height }
    toJSON() { return {} }
  }
  ;(globalThis as any).innerWidth = 1280
  ;(globalThis as any).innerHeight = 800
  ;(globalThis as any).navigator = {
    clipboard: {
      writeText: (t: string) => {
        clips.push(t)
        return Promise.resolve()
      },
    },
  }
})

afterEach(() => {
  for (const k of Object.keys(saved)) (globalThis as any)[k] = saved[k]
  jest.useRealTimers()
})

async function panelFixture() {
  const sessions = [mk("s1", { updated: NOW - 60_000, idle: NOW - 60_000 })]
  const b = panelBackend(sessions)
  const store = new Store(b.backend)
  await store.reload()
  const host = new FakeEl("div")
  const canvasCalls = { opened: [] as Array<string | undefined>, rect: null as DOMRect | null }
  const canvas = {
    setOpen: (id?: string) => void canvasCalls.opened.push(id),
    cardRect: (_id: string) => canvasCalls.rect,
  }
  let closedCount = 0
  const panel = new SessionPanel(host as any, store, b.backend, canvas as any, () => void closedCount++)
  const pinsToggled: string[] = []
  panel.tiles = { isPinned: () => false, togglePin: (id: string) => void pinsToggled.push(id) }
  return {
    panel,
    store,
    host,
    backend: b.backend,
    prompts: b.prompts,
    permCalls: b.permCalls,
    renames: b.renames,
    interrupts: b.interrupts,
    pinsToggled,
    canvasCalls,
    closed: () => closedCount,
    setFailPrompt: b.setFailPrompt,
    setFailPerms: b.setFailPerms,
  }
}

describe("SessionPanel", () => {
  it("opens on a session: the header mirrors the store and the transcript loads", async () => {
    const { panel, store } = await panelFixture()
    panel.open("s1")
    await flush()

    expect(panel.isOpen).toBe(true)
    const root = panel.el as unknown as FakeEl
    expect(root.dataset.status).toBe("succeeded")
    const proj = find(root, (e) => e.className.includes("head-project"))!
    expect(proj.textContent).toBe(store.projectLabel(store.sessions.get("s1")!)) // derived, content-agnostic
    expect(panel["transcript"]["messages"]).toHaveLength(1) // the backend page rendered
  })

  it("a failed send restores the draft and withdraws the optimistic row", async () => {
    const { panel, setFailPrompt } = await panelFixture()
    panel.open("s1")
    await flush()
    const input = panel["input"] as unknown as FakeEl
    input.value = "draft"
    setFailPrompt(true)
    input.fire("keydown", { key: "Enter", shiftKey: false, altKey: false, isComposing: false })
    await flush()
    expect(input.value).toBe("draft") // text put back for a retry
    expect(panel["transcript"]["inbox"]).toEqual([]) // optimistic row withdrawn
    // (the catch also toasts; its text is unreachable cross-file - see header)
  })

  it("a failed auto-approve toggle changes nothing; the success path flips it", async () => {
    const { panel, store, setFailPerms } = await panelFixture()
    panel.open("s1")
    await flush()

    setFailPerms(true)
    await panel["setAuto"]("s1", true) // caught at panel.ts 413
    expect(store.sessionAutoApproves("s1")).toBe(false) // store only writes permissions after the await

    setFailPerms(false)
    await panel["setAuto"]("s1", true)
    expect(store.sessionAutoApproves("s1")).toBe(true) // contrast: success really flips it
    expect(panel.isOpen).toBe(true)
  })

  it("the session menu lists its actions, runs them, and toggles itself", async () => {
    const { panel, store, pinsToggled } = await panelFixture()
    panel.open("s1")
    await flush()
    const root = panel.el as unknown as FakeEl
    const menuBtn = find(root, (e) => e.attrs["aria-label"] === "Session menu")!
    const pop = () => find(root, (e) => e.className.includes("popover"))
    const labels = (p: FakeEl) => p.children.map((b) => textOf(find(b, (e) => e.className.includes("pop-label"))!))

    menuBtn.fire("click")
    expect(labels(pop()!)).toEqual([
      "Auto-approve this session",
      "Pin to Tiles",
      "Copy resume command",
      "Copy session ID",
      "Rename",
    ])

    pop()!.children[1]!.fire("click") // Pin to Tiles -> wired to the tiles hook
    expect(pinsToggled).toEqual(["s1"])
    expect(pop()).toBeUndefined() // an item click closes the popover

    menuBtn.fire("click") // reopen
    expect(pop()).toBeDefined()
    menuBtn.fire("click") // second click toggles it closed
    expect(pop()).toBeUndefined()

    menuBtn.fire("click")
    pop()!.children[0]!.fire("click") // Auto-approve this session
    await flush()
    expect(store.sessionAutoApproves("s1")).toBe(true)
    expect(find(root, (e) => e.className.includes("auto-badge"))!.hidden).toBe(false)
  })

  it("copy items write the resume command to the clipboard", async () => {
    const { panel } = await panelFixture()
    panel.open("s1")
    await flush()
    const root = panel.el as unknown as FakeEl
    const menuBtn = find(root, (e) => e.attrs["aria-label"] === "Session menu")!
    menuBtn.fire("click")
    const pop = find(root, (e) => e.className.includes("popover"))!
    pop.children[2]!.fire("click") // Copy resume command
    await flush()
    expect(clips).toEqual(["hermes chat --resume s1"])
  })

  it("rename commits on Enter or blur and aborts on Escape", async () => {
    const { panel, store, renames } = await panelFixture()
    panel.open("s1")
    await flush()
    const root = panel.el as unknown as FakeEl
    const menuBtn = find(root, (e) => e.attrs["aria-label"] === "Session menu")!
    const titleEl = find(root, (e) => e.className === "panel-title")!
    const beginRename = () => {
      menuBtn.fire("click")
      find(root, (e) => e.className.includes("popover"))!.children.at(-1)!.fire("click") // Rename
    }

    beginRename()
    expect(titleEl.contentEditable).toBe("plaintext-only") // editing armed
    titleEl.textContent = "junk"
    titleEl.fire("keydown", { key: "Escape" })
    expect(titleEl.contentEditable).toBe("false")
    expect(store.sessions.get("s1")!.title).toBeUndefined() // aborted: nothing written
    expect(renames).toEqual([])

    beginRename()
    titleEl.textContent = "New name"
    titleEl.fire("keydown", { key: "Enter" })
    await flush()
    expect(store.sessions.get("s1")!.title).toBe("New name") // committed locally
    expect(titleEl.contentEditable).toBe("false")
    expect(renames).toEqual([{ id: "s1", title: "New name" }]) // and sent

    beginRename()
    titleEl.textContent = "Blurred name"
    titleEl.fire("blur") // focus loss commits too
    await flush()
    expect(store.sessions.get("s1")!.title).toBe("Blurred name")
    expect(renames).toHaveLength(2)
  })

  it("close() retires the panel once, after its exit timer, and hands the canvas back", async () => {
    const { panel, host, canvasCalls, closed } = await panelFixture()
    panel.open("s1")
    await flush()
    const root = panel.el as unknown as FakeEl
    const scrim = host.children[0]! // host = [scrim, el]
    expect(canvasCalls.opened).toEqual(["s1"])
    expect(scrim.className).toContain("visible") // open() showed it

    panel.close()
    expect(panel.isOpen).toBe(false) // the closing flag flips immediately
    expect(root.className).toContain("leaving")
    expect(scrim.className).not.toContain("visible")
    expect(closed()).toBe(0) // but nothing retires before the exit timer
    panel.close() // a second close while closing is a no-op
    jest.advanceTimersByTime(120)
    expect(closed()).toBe(1) // exactly one retirement
    expect(panel.id).toBeUndefined()
    expect(root.className).not.toContain("visible")
    expect(root.className).not.toContain("leaving")
    expect(root.className).not.toContain("animating") // exit cleanup clears them all
    expect(canvasCalls.opened).toStrictEqual(["s1", undefined]) // strict: toEqual ignores undefined elements
    expect(panel["transcript"].messages).toEqual([]) // session detached

    // The card-rect branch follows the card out and waits 380ms, not 120.
    canvasCalls.rect = new DOMRect(10, 20, 300, 400)
    panel.open("s1")
    await flush()
    panel.close()
    expect(root.style.left).toBe("10px") // snapped to the card's rect
    jest.advanceTimersByTime(120)
    expect(closed()).toBe(1) // still waiting on the longer exit
    jest.advanceTimersByTime(260)
    expect(closed()).toBe(2)
    panel.close() // nothing open now
    jest.advanceTimersByTime(500)
    expect(closed()).toBe(2) // no further retirement
    canvasCalls.rect = null
  })

  it("the Stop button interrupts the open session; focusInput focuses the composer", async () => {
    const { panel, interrupts } = await panelFixture()
    await panel["interrupt"]() // no session yet: early return
    expect(interrupts).toEqual([])

    panel.open("s1")
    await flush()
    const root = panel.el as unknown as FakeEl
    const stopBtn = find(root, (e) => e.className.includes("stop"))!
    stopBtn.fire("click")
    await flush()
    expect(interrupts).toEqual(["s1"])

    const input = panel["input"] as unknown as FakeEl
    let focused = 0
    input.focus = () => void focused++
    panel["focusInput"]()
    expect(focused).toBe(1)
  })
})
