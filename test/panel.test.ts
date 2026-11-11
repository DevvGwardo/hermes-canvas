import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import type { Backend } from "../src/app/backend"
import { timeAgo } from "../src/app/format"
import { SessionPanel } from "../src/app/panel"
import { Store } from "../src/app/store"
import type { Session } from "../src/app/types"

// T46: first coverage for SessionPanel (the expanded open session). No test
// imported src/app/panel.ts before this file, so the whole file was INVISIBLE
// to the lcov lane (unimported files are never instrumented). This pins the
// two catch bodies the iter-37 sweep surfaced as undriven - setAuto (panel.ts
// 413) and send (panel.ts 546) - plus the open baseline that makes those
// pins meaningful. The model-popover (ex T43) is now covered below: per-
// backend cache in models.ts gives deterministic listModels per fixture.
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
  src = ""
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

  click() {
    this.fire("click")
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

function installStorage(pinned: string | undefined) {
  const data: Record<string, string> = pinned ? { "occ.model": pinned } : {}
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (k in data ? data[k]! : null),
    setItem: (k: string, v: string) => void (data[k] = v),
    removeItem: (k: string) => void delete data[k],
  }
  return data
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

function panelBackend(
  sessions: Session[],
  opts: { models?: Array<{ id: string; providerID: string; name: string }>; failModels?: boolean; listModels?: () => Promise<Array<{ id: string; providerID: string; name: string }>> } = {},
) {
  const prompts: Array<{ id: string; text?: string; delivery?: string }> = []
  const permCalls: Array<{ id: string; rules: unknown }> = []
  const renames: Array<{ id: string; title: string }> = []
  const interrupts: string[] = []
  const viewed: string[] = []
  const switchCalls: Array<{ id: string; model: { id: string; providerID: string } }> = []
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
    markViewed: async (id: string) => {
      viewed.push(id)
    },
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
    listModels: opts.listModels
      ? opts.listModels
      : async () => {
          if (opts.failModels) throw new Error("boom")
          return opts.models ?? []
        },
    serverDefaultModel: async () => undefined,
    switchModel: async (id: string, model: { id: string; providerID: string }) => {
      switchCalls.push({ id, model })
    },
  }
  return {
    backend: backend as unknown as Backend,
    prompts,
    permCalls,
    renames,
    interrupts,
    viewed,
    switchCalls,
    setFailPrompt: (f: boolean) => void (failPrompt = f),
    setFailPerms: (f: boolean) => void (failPerms = f),
  }
}

let saved: Record<string, unknown> = {}
let clips: string[] = []

beforeEach(() => {
  jest.useFakeTimers() // keeps open()'s stray focus/cleanup timeouts inert
  clips = []
  for (const k of ["document", "window", "localStorage", "requestAnimationFrame", "matchMedia", "DOMRect", "innerWidth", "innerHeight", "navigator", "FileReader"])
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
  const win = new FakeEl("div") as any // FakeEl records resize so the test can fire it
  win.devicePixelRatio = 1
  ;(globalThis as any).window = win
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
  // src assigns onload BEFORE readAsDataURL, so a synchronous stub is faithful
  ;(globalThis as any).FileReader = class {
    onload: (() => void) | null = null
    result: string | null = null
    readAsDataURL(f: { type: string }) {
      this.result = `data:${f.type};base64,AAAA`
      this.onload?.()
    }
  }
})

afterEach(() => {
  for (const k of Object.keys(saved)) (globalThis as any)[k] = saved[k]
  jest.useRealTimers()
})

async function panelFixture(over: { s1Model?: { id: string; providerID: string }; models?: Array<{ id: string; providerID: string; name: string }>; failModels?: boolean; listModels?: () => Promise<Array<{ id: string; providerID: string; name: string }>> } = {}) {
  const sessions = [
    mk("s1", { updated: NOW - 60_000, idle: NOW - 60_000 }, over.s1Model ? { model: over.s1Model } : {}),
    mk("s2", { updated: NOW - 120_000, idle: NOW - 120_000 }, { parentID: "s1", title: "Kid work" }), // subagent of s1
  ]
  const b = panelBackend(sessions, { models: over.models, failModels: over.failModels, listModels: over.listModels })
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
    viewed: b.viewed,
    pinsToggled,
    canvasCalls,
    closed: () => closedCount,
    switchCalls: b.switchCalls,
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

  it("the Subagents button lists this session's kids and steers to them", async () => {
    const { panel } = await panelFixture()
    panel.open("s1")
    await flush()
    const root = panel.el as unknown as FakeEl
    const subBtn = find(root, (e) => e.className.includes("subagents"))!
    const pop = () => find(root, (e) => e.className.includes("popover"))

    subBtn.fire("click")
    const rows = pop()!.children
    expect(rows).toHaveLength(1) // s2 is s1's kid (parentID in the fixture)
    expect(textOf(find(rows[0]!, (e) => e.className.includes("pop-label"))!)).toBe("Kid work")
    const sub = textOf(find(rows[0]!, (e) => e.className.includes("pop-sub"))!)
    expect(sub.startsWith("subagent")).toBe(true) // no agent set: the fallback label
    expect(sub.endsWith(timeAgo(NOW - 120_000))).toBe(true) // its updated time, relatively

    rows[0]!.fire("click") // running the kid row steers the panel to it
    await flush()
    expect(pop()).toBeUndefined()
    expect(panel.id).toBe("s2")

    subBtn.fire("click") // s2 has no kids of its own: an empty popover
    expect(pop()!.children).toHaveLength(0)
    subBtn.fire("click") // second click toggles it closed
    expect(pop()).toBeUndefined()
  })

  it("finishing an execution marks viewed; resize and autosize re-apply geometry", async () => {
    const { panel, store, viewed } = await panelFixture()
    const root = panel.el as unknown as FakeEl
    const input = panel["input"] as unknown as FakeEl
    const finished = () => panel["transcript"]["onEvent"]({ type: "session.execution.succeeded", data: { sessionID: "s1" } } as any)

    finished() // no session yet: the onFinished guard marks nothing
    expect(viewed).toEqual([])

    panel.open("s1")
    await flush()
    expect(viewed).toEqual(["s1"]) // open() itself counts as reviewed

    // a finish bumps idle -> unseen again; watching it finish converts it to seen
    store.sessions.get("s1")!.time.idle = Date.now() + 1000
    finished()
    expect(viewed).toEqual(["s1", "s1"])
    finished() // still seen: markViewed dedupes, no second backend call
    expect(viewed).toEqual(["s1", "s1"])

    // resize recomputes the panel rect against the new viewport
    ;(globalThis as any).innerHeight = 900
    ;(globalThis as any).window.fire("resize")
    expect(root.style.height).toBe(`${900 - 24 - 74}px`)

    // composer autosize: growth caps at 220px
    input.scrollHeight = 500
    input.fire("input")
    expect(input.style.height).toBe("220px")
  })

  it("pasting an image attaches a removable chip; text pastes are ignored", async () => {
    const { panel } = await panelFixture()
    panel.open("s1")
    await flush()
    const input = panel["input"] as unknown as FakeEl
    const attachRow = panel["attachRow"] as unknown as FakeEl
    const chips = () => attachRow.children

    let prevented = 0
    input.fire("paste", {
      clipboardData: { files: [{ type: "text/plain", name: "notes.txt" }] },
      preventDefault: () => void prevented++,
    })
    expect(chips()).toHaveLength(0) // non-images are ignored...
    expect(prevented).toBe(0) // ...without swallowing the paste

    input.fire("paste", {
      clipboardData: { files: [{ type: "image/png", name: "shot.png" }] },
      preventDefault: () => void prevented++,
    })
    expect(prevented).toBe(1)
    expect(chips()).toHaveLength(1)
    const chip = chips()[0]!
    expect(chip.className).toContain("attach-chip")
    expect(find(chip, (e) => e.tag === "img")!.src).toBe("data:image/png;base64,AAAA")
    expect(textOf(chip)).toContain("shot.png")

    find(chip, (e) => e.className === "x")!.fire("click") // the x detaches it
    expect(chips()).toHaveLength(0)

    input.fire("paste", {
      clipboardData: { files: [{ type: "image/jpeg", name: "" }] },
      preventDefault: () => void prevented++,
    })
    expect(textOf(chips()[0]!)).toContain("image.png") // nameless paste falls back
  })

  it("dropping an image onto the panel attaches it; dragover is claimed", async () => {
    const { panel } = await panelFixture()
    panel.open("s1")
    await flush()
    const root = panel.el as unknown as FakeEl
    const attachRow = panel["attachRow"] as unknown as FakeEl

    let claimed = 0
    root.fire("dragover", { preventDefault: () => void claimed++ })
    expect(claimed).toBe(1) // the panel claims the drag

    root.fire("drop", { dataTransfer: { files: [{ type: "image/png", name: "drop.png" }] } })
    expect(attachRow.children).toHaveLength(1)
    expect(textOf(attachRow.children[0]!)).toContain("drop.png")

    root.fire("drop", { dataTransfer: { files: [{ type: "application/pdf", name: "doc.pdf" }] } })
    expect(attachRow.children).toHaveLength(1) // non-image drops add nothing
  })

  it("model popover lists models with current + pinned-default marks and filters", async () => {
    const models = [
      { id: "a1", providerID: "alpha", name: "Alpha One" },
      { id: "b2", providerID: "beta", name: "Beta Two" },
      { id: "c3", providerID: "gamma", name: "Gamma Three" },
    ]
    const { panel } = await panelFixture({ s1Model: { id: "b2", providerID: "beta" }, models })
    installStorage("alpha/a1") // pinned default for NEW sessions, distinct from this session's current
    panel.open("s1")
    await flush()
    const root = panel.el as unknown as FakeEl
    const modelBtn = find(root, (e) => e.className.split(/\s+/).includes("model"))!
    modelBtn.fire("click", { stopPropagation: () => {} })
    await flush()
    const pop = find(root, (e) => e.className.includes("popover"))!
    expect(pop.className).toContain("models")
    const filter = pop.children[0]!
    const list = pop.children[1]!
    expect(filter.placeholder).toBe("Search models")
    expect(list.children.map((b) => textOf(find(b, (e) => e.className.includes("pop-label"))!))).toEqual(["Alpha One", "Beta Two", "Gamma Three"])
    expect(list.children[1]!.className).toContain("current") // beta is this session's model
    expect(list.children[0]!.className).not.toContain("current")
    expect(textOf(find(list.children[0]!, (e) => e.className.includes("pop-sub"))!)).toContain("default for new sessions")
    expect(textOf(find(list.children[1]!, (e) => e.className.includes("pop-sub"))!)).not.toContain("default for new sessions")

    filter.value = "gamma"
    filter.fire("input")
    expect(list.children).toHaveLength(1)
    expect(textOf(list.children[0]!)).toContain("Gamma Three")

    filter.value = "zzz-nope"
    filter.fire("input")
    expect(list.children).toHaveLength(1)
    expect(list.children[0]!.className).toContain("pop-empty")
    expect(list.children[0]!.textContent).toBe("No matching models")

    modelBtn.fire("click", { stopPropagation: () => {} }) // second click toggles closed
    expect(find(root, (e) => e.className.includes("popover"))).toBeUndefined()
  })

  it("choosing a model sets the session model, pins it, and calls switchModel; Enter chooses the first row", async () => {
    const models = [
      { id: "a1", providerID: "alpha", name: "Alpha One" },
      { id: "b2", providerID: "beta", name: "Beta Two" },
    ]
    const { panel, store, switchCalls } = await panelFixture({ models })
    const data = installStorage(undefined)
    panel.open("s1")
    await flush()
    const root = panel.el as unknown as FakeEl
    const modelBtn = find(root, (e) => e.className.split(/\s+/).includes("model"))!
    modelBtn.fire("click", { stopPropagation: () => {} })
    await flush()
    const pop = find(root, (e) => e.className.includes("popover"))!
    const list = pop.children[1]!
    list.children[1]!.fire("click") // Beta Two by click
    await flush()
    expect(find(root, (e) => e.className.includes("popover"))).toBeUndefined()
    expect(store.sessions.get("s1")!.model).toEqual({ id: "b2", providerID: "beta" })
    expect(data["occ.model"]).toBe("beta/b2")
    expect(switchCalls).toEqual([{ id: "s1", model: { id: "b2", providerID: "beta" } }])
    expect((panel["modelBtn"] as unknown as FakeEl).textContent).toBe("b2") // header shows the model id, not its display name

    // keyboard path: reopen, Enter picks the first row
    installStorage(undefined)
    modelBtn.fire("click", { stopPropagation: () => {} })
    await flush()
    const pop2 = find(root, (e) => e.className.includes("popover"))!
    const filter2 = pop2.children[0]!
    filter2.value = "alpha"
    filter2.fire("input")
    filter2.fire("keydown", { key: "Enter", stopPropagation: () => {} })
    await flush()
    expect(store.sessions.get("s1")!.model).toEqual({ id: "a1", providerID: "alpha" })
    expect(switchCalls.at(-1)).toEqual({ id: "s1", model: { id: "a1", providerID: "alpha" } })
    expect((panel["modelBtn"] as unknown as FakeEl).textContent).toBe("a1")
    expect(find(root, (e) => e.className.includes("popover"))).toBeUndefined()
  })

  it("Escape closes the model popover; a failed list shows the error row and stays open", async () => {
    const models = [{ id: "a1", providerID: "alpha", name: "Alpha One" }]
    const { panel } = await panelFixture({ models })
    installStorage(undefined)
    panel.open("s1")
    await flush()
    const root = panel.el as unknown as FakeEl
    const modelBtn = find(root, (e) => e.className.split(/\s+/).includes("model"))!
    modelBtn.fire("click", { stopPropagation: () => {} })
    await flush()
    const pop = find(root, (e) => e.className.includes("popover"))!
    const filter = pop.children[0]!
    filter.fire("keydown", { key: "Escape", stopPropagation: () => {} })
    expect(find(root, (e) => e.className.includes("popover"))).toBeUndefined()

    // failure path needs a fresh backend identity: fresh fixture with failModels
    const f2 = await panelFixture({ failModels: true })
    installStorage(undefined)
    f2.panel.open("s1")
    await flush()
    const root2 = f2.panel.el as unknown as FakeEl
    const btn2 = find(root2, (e) => e.className.split(/\s+/).includes("model"))!
    btn2.fire("click", { stopPropagation: () => {} })
    await flush()
    const pop2 = find(root2, (e) => e.className.includes("popover"))!
    const list2 = pop2.children[1]!
    expect(list2.children).toHaveLength(1)
    expect(list2.children[0]!.className).toContain("pop-empty")
    expect(list2.children[0]!.textContent).toContain("Couldn't list models: boom")
  })

  it("closing the model popover while loading drops the late result", async () => {
    let resolveList!: (v: Array<{ id: string; providerID: string; name: string }>) => void
    const pending = new Promise<Array<{ id: string; providerID: string; name: string }>>((r) => (resolveList = r))
    const { panel } = await panelFixture({ listModels: () => pending })
    installStorage(undefined)
    panel.open("s1")
    await flush()
    const root = panel.el as unknown as FakeEl
    const modelBtn = find(root, (e) => e.className.split(/\s+/).includes("model"))!
    modelBtn.fire("click", { stopPropagation: () => {} })
    // do not await yet: the fetch is pending, the Loading row is up
    const pop = find(root, (e) => e.className.includes("popover"))!
    expect(pop.children[1]!.children[0]!.textContent).toBe("Loading models…")
    modelBtn.fire("click", { stopPropagation: () => {} }) // close before the fetch lands
    expect(find(root, (e) => e.className.includes("popover"))).toBeUndefined()
    resolveList([{ id: "a1", providerID: "alpha", name: "Alpha One" }])
    await flush()
    expect(find(root, (e) => e.className.includes("popover"))).toBeUndefined() // late result dropped, nothing reappears
  })

  it("queues on Tab only while running, restores attachments on failed send, and warns on live-image sends", async () => {
    const { panel, store, prompts, setFailPrompt } = await panelFixture()
    panel.open("s1")
    await flush()
    const input = panel["input"] as unknown as FakeEl
    const attachRow = panel["attachRow"] as unknown as FakeEl

    // Idle: Tab must NOT queue
    input.value = "stay in draft"
    input.fire("keydown", { key: "Tab", shiftKey: false, altKey: false, isComposing: false })
    await flush()
    expect(prompts).toEqual([])
    expect(input.value).toBe("stay in draft")

    // Running: Tab queues and failed send restores both draft and pasted image
    store.running.add("s1")
    input.fire("paste", {
      clipboardData: { files: [{ type: "image/png", name: "snap.png" }] },
      preventDefault: () => {},
    })
    expect(attachRow.children).toHaveLength(1)
    setFailPrompt(true)
    input.fire("keydown", { key: "Tab", shiftKey: false, altKey: false, isComposing: false })
    await flush()
    expect(input.value).toBe("stay in draft")
    expect(attachRow.children).toHaveLength(1)

    setFailPrompt(false)
    input.fire("keydown", { key: "Tab", shiftKey: false, altKey: false, isComposing: false })
    await flush()
    expect(prompts).toEqual([{ id: "s1", text: "stay in draft", delivery: "queue", files: [{ name: "snap.png", uri: "data:image/png;base64,AAAA" }] }] as any)

    // Live backend image-only send aborts cleanly without dropping the attachment;
    // also ignores leaked demo/demo-model pinned default in localStorage (I2).
    installStorage("demo/demo-model")
    let livePrompts = 0
    const liveBackend = {
      kind: "live",
      listProjects: async () => [],
      listSessions: async () => [mk("s1", { updated: NOW - 60_000, idle: NOW - 60_000 })],
      active: async () => new Set<string>(),
      messages: async () => ({ data: [] }),
      inbox: async () => [],
      markViewed: async () => {},
      listModels: async () => [{ id: "demo-model", providerID: "demo", name: "Demo Model" }],
      serverDefaultModel: async () => undefined,
      prompt: async () => {
        livePrompts++
      },
    } as unknown as Backend
    const liveStore = new Store(liveBackend)
    await liveStore.reload()
    const liveHost = new FakeEl("div")
    const livePanel = new SessionPanel(liveHost as any, liveStore, liveBackend, { setOpen() {}, cardRect: () => null } as any, () => {})
    livePanel.open("s1")
    await flush()
    const liveRoot = livePanel.el as unknown as FakeEl
    find(liveRoot, (e) => e.className.split(/\s+/).includes("model"))!.fire("click", { stopPropagation: () => {} })
    await flush()
    const livePop = find(liveRoot, (e) => e.className.includes("popover"))!
    expect(textOf(livePop)).not.toContain("default for new sessions")
    livePanel.handleEscape()
    const liveInput = livePanel["input"] as unknown as FakeEl
    const liveAttach = livePanel["attachRow"] as unknown as FakeEl
    liveInput.fire("paste", {
      clipboardData: { files: [{ type: "image/png", name: "img.png" }] },
      preventDefault: () => {},
    })
    liveInput.fire("keydown", { key: "Enter", shiftKey: false, altKey: false, isComposing: false })
    await flush()
    expect(livePrompts).toBe(0)
    expect(liveAttach.children).toHaveLength(1)
    livePanel.destroy()
  })

  it("handles rename rollback, single-commit guard, model-switch rollback, reopen while closing, handleEscape, and missing clipboard", async () => {
    const models = [
      { id: "a1", providerID: "alpha", name: "Alpha One" },
      { id: "b2", providerID: "beta", name: "Beta Two" },
    ]
    const s1 = mk("s1", { updated: NOW - 60_000, idle: NOW - 60_000 }, { model: { id: "a1", providerID: "alpha" }, title: "Old" })
    let renameCalls = 0
    const backend = {
      kind: "live",
      listProjects: async () => [],
      listSessions: async () => [s1],
      active: async () => new Set<string>(),
      messages: async () => ({ data: [] }),
      inbox: async () => [],
      markViewed: async () => {},
      rename: async () => {
        renameCalls++
        throw new Error("rename denied")
      },
      listModels: async () => models,
      serverDefaultModel: async () => undefined,
      switchModel: async () => {
        throw new Error("switch denied")
      },
    } as unknown as Backend
    const store = new Store(backend)
    await store.reload()
    const host = new FakeEl("div")
    let closedCount = 0
    const panel = new SessionPanel(host as any, store, backend, { setOpen() {}, cardRect: () => null } as any, () => void closedCount++)
    panel.open("s1")
    await flush()

    const root = panel.el as unknown as FakeEl
    const titleEl = find(root, (e) => e.className === "panel-title")!
    const menuBtn = find(root, (e) => e.attrs["aria-label"] === "Session menu")!
    const modelBtn = find(root, (e) => e.className.split(/\s+/).includes("model"))!

    // Clipboard unavailable does not throw
    ;(globalThis as any).navigator = {}
    menuBtn.fire("click")
    find(root, (e) => e.className.includes("popover"))!.children[2]!.fire("click")

    // Rename Enter + immediate blur only submits once, collapses newlines, and rolls back on failure
    menuBtn.fire("click")
    find(root, (e) => e.className.includes("popover"))!.children.at(-1)!.fire("click")
    titleEl.textContent = "Line 1\nLine 2"
    titleEl.fire("keydown", { key: "Enter" })
    titleEl.fire("blur")
    expect(renameCalls).toBe(1)
    await flush()
    expect(store.sessions.get("s1")!.title).toBe("Old")

    // Switch model rolls back session model and storage on error
    const lsData = installStorage(undefined)
    modelBtn.fire("click")
    await flush()
    const pop = find(root, (e) => e.className.includes("popover"))!
    pop.children[1]!.children[1]!.fire("click")
    await flush()
    expect(store.sessions.get("s1")!.model).toEqual({ id: "a1", providerID: "alpha" })
    expect(lsData["occ.model"]).toBeUndefined()

    // handleEscape closes an open popover first, then the panel; reopen while closing cancels exit timer
    menuBtn.fire("click")
    expect(find(root, (e) => e.className.includes("popover"))).toBeDefined()
    expect(panel.handleEscape()).toBe(true)
    expect(find(root, (e) => e.className.includes("popover"))).toBeUndefined()
    expect(panel.isOpen).toBe(true)

    expect(panel.handleEscape()).toBe(true)
    expect(root.className).toContain("leaving")
    panel.open("s1")
    expect(root.className).not.toContain("leaving")
    jest.advanceTimersByTime(500)
    expect(closedCount).toBe(0)
    expect(panel.isOpen).toBe(true)

    // Popover keyboard navigation (ArrowDown/ArrowUp/Escape), model popover ArrowDown+Enter, and pointerdown dismiss
    menuBtn.fire("click")
    const menuPop = find(root, (e) => e.className.includes("popover"))!
    const focusedItems: FakeEl[] = []
    menuPop.children.forEach((btn) => {
      btn.focus = () => void focusedItems.push(btn)
    })
    menuPop.fire("keydown", { key: "ArrowDown" })
    expect(focusedItems[0]).toBe(menuPop.children[0])
    menuPop.fire("keydown", { key: "Escape" })
    expect(panel.hasPopover()).toBe(false)

    // Model popover ArrowDown selects second model row
    modelBtn.fire("click")
    await flush()
    const modPop = find(root, (e) => e.className.includes("popover"))!
    modPop.children[0]!.fire("keydown", { key: "ArrowDown" })
    expect(modPop.children[1]!.children[1]!.className).toContain("active")
    root.fire("pointerdown")
    expect(panel.hasPopover()).toBe(false)

    panel.destroy()
  })
})
