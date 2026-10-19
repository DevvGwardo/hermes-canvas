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

  removeEventListener() {}

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
    interrupt: async () => {},
    replyPermission: async () => {},
    replyForm: async () => {},
    cancelForm: async () => {},
    cancelInbox: async () => {},
    setInboxDelivery: async () => {},
    setSessionPermissions: async (id: string, rules: unknown) => {
      if (failPerms) throw new Error("denied")
      permCalls.push({ id, rules })
    },
  }
  return {
    backend: backend as unknown as Backend,
    prompts,
    permCalls,
    setFailPrompt: (f: boolean) => void (failPrompt = f),
    setFailPerms: (f: boolean) => void (failPerms = f),
  }
}

let saved: Record<string, unknown> = {}

beforeEach(() => {
  jest.useFakeTimers() // keeps open()'s stray focus/cleanup timeouts inert
  for (const k of ["document", "window", "localStorage", "requestAnimationFrame", "matchMedia", "DOMRect", "innerWidth", "innerHeight"])
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
  const canvas = { setOpen: (_id?: string) => {}, cardRect: () => null }
  const panel = new SessionPanel(host as any, store, b.backend, canvas as any, () => {})
  return { panel, store, host, backend: b.backend, prompts: b.prompts, permCalls: b.permCalls, setFailPrompt: b.setFailPrompt, setFailPerms: b.setFailPerms }
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
})
