import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"

;(globalThis as any).__HERMES_TEST__ = true
const mainMod = await import("../src/app/main")
const { Store } = await import("../src/app/store")
const { pref, segmented, showUnavailable, boot } = mainMod

class FakeStyle {
  [k: string]: any
  setProperty(k: string, v: string) {
    this[k] = v
  }
}

class FakeElement {
  tag: string
  id = ""
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
  autocomplete = ""
  draggable = false
  contentEditable = ""
  src = ""
  alt = ""
  width = 0
  height = 0
  style = new FakeStyle()
  dataset: Record<string, string> = {}
  attrs: Record<string, string> = {}
  children: FakeElement[] = []
  parent: FakeElement | null = null
  handlers: Record<string, Array<(e: any) => void>> = {}
  scrollTop = 0
  scrollHeight = 0
  clientWidth = 1280
  clientHeight = 800
  offsetWidth = 300
  offsetHeight = 180
  ownerDocument: any
  private html = ""

  constructor(tag: string, ownerDocument?: any) {
    this.tag = tag
    this.ownerDocument = ownerDocument
  }

  get isConnected() {
    let cur: FakeElement | null = this
    while (cur.parent) cur = cur.parent
    return cur === this.ownerDocument?.body || cur === this.ownerDocument?.documentElement || cur.tag === "div"
  }

  get parentElement() {
    return this.parent
  }

  get parentNode() {
    return this.parent
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null
  }

  get nextElementSibling(): FakeElement | null {
    if (!this.parent) return null
    const i = this.parent.children.indexOf(this)
    return this.parent.children[i + 1] ?? null
  }

  get innerHTML() {
    return this.html
  }

  set innerHTML(v: string) {
    this.html = v
    for (const c of this.children) c.parent = null
    this.children = []
    for (const m of v.matchAll(/<span[^>]*class="([^"]*)"[^>]*>([^<]*)<\/span>/g)) {
      const s = new FakeElement("span", this.ownerDocument)
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
      const el = typeof n === "string" ? new FakeElement("#text", this.ownerDocument) : n
      if (typeof n === "string") el.textContent = n
      el.parent?.removeChild(el)
      el.parent = this
      this.children.push(el)
    }
  }

  prepend(...nodes: any[]) {
    const adopted = nodes.map((n) => {
      if (typeof n === "string") {
        const t = new FakeElement("#text", this.ownerDocument)
        t.textContent = n
        return t
      }
      return n
    })
    for (const el of adopted) {
      el.parent?.removeChild(el)
      el.parent = this
    }
    this.children.unshift(...adopted)
  }

  after(...nodes: any[]) {
    if (!this.parent) return
    const idx = this.parent.children.indexOf(this)
    if (idx < 0) return
    let ref = this.parent.children[idx + 1] ?? null
    for (const n of nodes) {
      const el = typeof n === "string" ? new FakeElement("#text", this.ownerDocument) : n
      if (typeof n === "string") el.textContent = n
      this.parent.insertBefore(el, ref)
    }
  }

  removeChild(el: FakeElement) {
    const i = this.children.indexOf(el)
    if (i >= 0) this.children.splice(i, 1)
  }

  remove() {
    this.parent?.removeChild(this)
    this.parent = null
  }

  replaceWith(el: FakeElement) {
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

  insertBefore(node: FakeElement, ref: FakeElement | null): FakeElement {
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

  contains(el: FakeElement | null) {
    while (el) {
      if (el === this) return true
      el = el.parent
    }
    return false
  }

  setAttribute(k: string, v: string) {
    this.attrs[k] = v
  }

  removeAttribute(k: string) {
    delete this.attrs[k]
  }

  addEventListener(type: string, fn: (e: any) => void, opts?: { signal?: AbortSignal }) {
    if (opts?.signal?.aborted) return
    ;(this.handlers[type] ??= []).push(fn)
    opts?.signal?.addEventListener("abort", () => this.removeEventListener(type, fn), { once: true })
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

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this
  }

  blur() {
    if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null
  }

  select() {}
  scrollIntoView() {}
  setPointerCapture() {}

  private matchesSimple(s: string): boolean {
    s = s.trim()
    if (!s) return false
    const attrM = s.match(/^\[([a-zA-Z0-9_-]+)=['"]?([^'"\]]+)['"]?\]$/)
    if (attrM) {
      const k = attrM[1]!
      const v = attrM[2]!
      if (k === "contenteditable") return this.contentEditable === v || this.attrs[k] === v
      return this.attrs[k] === v
    }
    const parts = s.split(/(?=[.#])/).filter(Boolean)
    if (parts.length > 1) return parts.every((p) => this.matchesSimple(p))
    if (s.startsWith(".")) return this.className.split(/\s+/).includes(s.slice(1))
    if (s.startsWith("#")) return this.id === s.slice(1)
    return this.tag === s
  }

  private matchesChain(sel: string): boolean {
    const chain = sel.trim().split(/\s+(?![^[]*\])/).filter(Boolean)
    if (!chain.length) return false
    if (!this.matchesSimple(chain[chain.length - 1]!)) return false
    let anc = this.parent
    for (let i = chain.length - 2; i >= 0; i--) {
      while (anc && !anc.matchesSimple(chain[i]!)) anc = anc.parent
      if (!anc) return false
      anc = anc.parent
    }
    return true
  }

  matches(sel: string) {
    return sel.split(",").some((part) => this.matchesChain(part))
  }

  closest(sel: string): FakeElement | null {
    let n: FakeElement | null = this
    while (n) {
      if (n.matches(sel)) return n
      n = n.parent
    }
    return null
  }

  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = []
    for (const c of this.children) {
      if (c.matches(sel)) out.push(c)
      out.push(...c.querySelectorAll(sel))
    }
    return out
  }

  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null
  }

  getBoundingClientRect() {
    return { width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }
  }

  getContext() {
    return new Proxy({}, { get: () => () => {} })
  }
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function driveRaf() {
  for (const cb of rafQueue.splice(0)) cb()
}

let saved: Record<string, any> = {}
let rafQueue: Array<() => void> = []
let winHandlers: Record<string, Array<(e: any) => void>> = {}
let handles: Array<{ destroy(): void }> = []

function installDom(search = "?demo=1", hash = "") {
  rafQueue = []
  winHandlers = {}
  const storage = new Map<string, string>()
  const doc: any = {
    title: "Hermes Canvas",
    activeElement: null,
    createElement: (tag: string) => new FakeElement(tag, doc),
    createTextNode: (t: string) => {
      const n = new FakeElement("#text", doc)
      n.textContent = t
      return n
    },
    getElementById: () => null,
    getSelection: () => ({ selectAllChildren: () => {}, toString: () => "" }),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  doc.body = new FakeElement("body", doc)
  doc.documentElement = new FakeElement("html", doc)
  const root = new FakeElement("div", doc)
  root.id = "app"
  doc.body.append(root)
  doc.getElementById = (id: string) => (id === "app" ? root : null)

  const loc = {
    href: `http://localhost/${search}${hash}`,
    pathname: "/",
    search,
    hash,
    reload: jest.fn(),
  }
  const hist = {
    replaceState: jest.fn((_s: unknown, _t: string, url: string) => {
      const u = new URL(url, "http://localhost")
      loc.pathname = u.pathname
      loc.search = u.search
      loc.hash = u.hash
      loc.href = u.toString()
    }),
  }

  ;(globalThis as any).Element = FakeElement
  ;(globalThis as any).document = doc
  ;(globalThis as any).window = {
    devicePixelRatio: 1,
    addEventListener: (type: string, fn: (e: any) => void) => {
      ;(winHandlers[type] ??= []).push(fn)
    },
    removeEventListener: (type: string, fn: (e: any) => void) => {
      winHandlers[type] = (winHandlers[type] ?? []).filter((f) => f !== fn)
    },
    getSelection: () => ({ toString: () => "" }),
  }
  ;(globalThis as any).location = loc
  ;(globalThis as any).history = hist
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
  }
  ;(globalThis as any).matchMedia = () => ({ matches: false })
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  ;(globalThis as any).getComputedStyle = () => ({
    getPropertyValue: () => "",
  })
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
  ;(globalThis as any).requestAnimationFrame = (cb: () => void) => {
    rafQueue.push(cb)
    return rafQueue.length
  }
  ;(globalThis as any).navigator = { clipboard: { writeText: async () => {} } }
  ;(globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ({ mode: "demo", connected: true, userHome: "/Users/you" }),
  })
  return { root, doc, loc, hist, storage }
}

beforeEach(() => {
  jest.useFakeTimers()
  handles = []
  for (const k of [
    "Element",
    "document",
    "window",
    "location",
    "history",
    "localStorage",
    "matchMedia",
    "ResizeObserver",
    "getComputedStyle",
    "DOMRect",
    "innerWidth",
    "innerHeight",
    "requestAnimationFrame",
    "navigator",
    "fetch",
  ]) {
    saved[k] = (globalThis as any)[k]
  }
})

afterEach(() => {
  for (const h of handles) h.destroy()
  for (const k of Object.keys(saved)) (globalThis as any)[k] = saved[k]
  jest.useRealTimers()
})

function fireWinKey(key: string, extra: Record<string, any> = {}) {
  const ev = {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    target: (globalThis as any).document.body,
    ...extra,
  }
  for (const fn of winHandlers["keydown"] ?? []) fn(ev)
  return ev
}

describe("main — pref & segmented & showUnavailable", () => {
  it("pref validates allowed values and survives throwing localStorage", () => {
    installDom()
    expect(pref.get("layout", "tree", ["tree", "fold"] as const)).toBe("tree")
    pref.set("layout", "fold")
    expect(pref.get("layout", "tree", ["tree", "fold"] as const)).toBe("fold")
    pref.set("layout", "bogus")
    expect(pref.get("layout", "tree", ["tree", "fold"] as const)).toBe("tree")

    ;(globalThis as any).localStorage = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
    }
    expect(pref.get("layout", "tree", ["tree", "fold"] as const)).toBe("tree")
    expect(() => pref.set("layout", "fold")).not.toThrow()
  })

  it("segmented renders radiogroup buttons with type=button and aria-checked", () => {
    installDom()
    const picked: string[] = []
    const seg = segmented(["a", "b"] as const, { a: "Alpha", b: "Beta" }, "a", (v) => picked.push(v), "Mode")
    const group = seg.group as unknown as FakeElement
    expect(group.attrs["role"]).toBe("radiogroup")
    expect(group.attrs["aria-label"]).toBe("Mode")
    expect(group.children).toHaveLength(2)
    expect(group.children[0]!.type).toBe("button")
    expect(group.children[0]!.attrs["role"]).toBe("radio")
    expect(group.children[0]!.attrs["aria-checked"]).toBe("true")
    expect(group.children[1]!.attrs["aria-checked"]).toBe("false")

    group.children[1]!.click()
    expect(picked).toEqual(["b"])
    expect(group.children[1]!.attrs["aria-checked"]).toBe("true")
    expect(group.children[0]!.attrs["aria-checked"]).toBe("false")
  })

  it("showUnavailable renders the error message and action buttons", () => {
    const { root } = installDom("?demo=1")
    showUnavailable(root as any, { mode: "live", connected: false, error: "Custom store failure" })
    const h1 = root.querySelector("h1")!
    const p = root.querySelector("p")!
    expect(h1.textContent).toBe("Can't reach Hermes")
    expect(p.textContent).toBe("Custom store failure")
    expect(root.querySelectorAll("button").map((b) => b.type)).toEqual(["button", "button"])
  })
})

describe("main — boot lifecycle, routing, and keyboard handling", () => {
  it("renders unavailable state without listeners when disconnected and not demo", async () => {
    const { root } = installDom("")
    ;(globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({ mode: "live", connected: false, error: "Offline" }),
    })
    const handle = await boot(root as any)
    expect(handle).toBeUndefined()
    expect(root.querySelector("h1")!.textContent).toBe("Can't reach Hermes")
    expect(root.querySelector("p")!.textContent).toBe("Offline")
  })

  it("boots in demo mode, cleans up via destroy(), and coordinates overlay transitions & Escape precedence", async () => {
    const { root, loc } = installDom("?demo=1")
    const app = (await boot(root as any))!
    expect(app).toBeDefined()
    handles.push(app)
    driveRaf()
    expect(root.classList.contains("ready")).toBe(true)

    const sessionId = app.store.roots()[0]!.id
    // Open picker (N) and ensure background shortcuts do not fire while open
    fireWinKey("n")
    expect(app.picker.isOpen).toBe(true)
    fireWinKey("t")
    expect(app.tiles.isOpen).toBe(false)
    // Global Escape delegates to picker
    fireWinKey("Escape")
    expect(app.picker.isOpen).toBe(false)

    // Open tiles (T), then Escape closes tiles
    fireWinKey("t")
    expect(app.tiles.isOpen).toBe(true)
    expect(loc.hash).toBe("#tiles")
    fireWinKey("Escape")
    expect(app.tiles.isOpen).toBe(false)

    // Open help (?), Escape closes help before closing tiles/panel
    fireWinKey("t")
    expect(app.tiles.isOpen).toBe(true)
    const helpBtn = root.querySelector('[aria-label="Keyboard shortcuts"]')!
    helpBtn.click()
    expect(helpBtn.attrs["aria-expanded"]).toBe("true")
    fireWinKey("Escape")
    expect(helpBtn.attrs["aria-expanded"]).toBe("false")
    expect(app.tiles.isOpen).toBe(true)
    fireWinKey("Escape")
    expect(app.tiles.isOpen).toBe(false)

    // Open panel via click-to-open and switch directly to Tiles without clobbering #tiles hash
    app.canvas.activate(sessionId)
    await flush()
    expect(app.panel.isOpen).toBe(true)
    expect(loc.hash).toBe(`#${sessionId}`)

    // Space / button interaction inside panel must NOT hijack focus to composer
    let focusedComposer = 0
    const compInput = (app.panel as any).input as FakeElement
    const origFocus = compInput.focus.bind(compInput)
    compInput.focus = () => {
      focusedComposer++
      origFocus()
    }
    fireWinKey(" ", { target: app.panel.el })
    const stopBtn = (app.panel.el as unknown as FakeElement).querySelector(".stop")!
    fireWinKey("x", { target: stopBtn })
    expect(focusedComposer).toBe(0)

    // Click Tiles button while panel is open -> panel closes, tiles opens, and after 380ms exit timer #tiles stays!
    root.querySelector(".tiles-open-btn")!.click()
    expect(app.tiles.isOpen).toBe(true)
    expect(loc.hash).toBe("#tiles")
    jest.advanceTimersByTime(400)
    expect(loc.hash).toBe("#tiles")

    // Pressing N (or T) when Launchpad menu is open -> Escape closes menu first without closing tiles
    app.launchpad.focus()
    const destBtn = root.querySelector(".launch-dest")!
    destBtn.click()
    expect((app.launchpad as any).menu).toBeDefined()
    fireWinKey("Escape")
    expect((app.launchpad as any).menu).toBeUndefined()
    expect(app.tiles.isOpen).toBe(true)

    app.destroy()
    expect(winHandlers["keydown"] ?? []).toHaveLength(0)
    expect(app.store.onAutoApproved).toBeUndefined()
    const aaBtn = root.querySelector(".topbar .aa-toggle")!
    aaBtn.click()
    expect(aaBtn.classList.contains("confirming")).toBe(false)
  })

  it("handles Cmd/Ctrl+. global interrupt on running tile/panel", async () => {
    const { root } = installDom("?demo=1")
    const app = (await boot(root as any))!
    handles.push(app)
    driveRaf()
    const sessionId = app.store.roots()[0]!.id
    app.store.running.add(sessionId)
    app.canvas.activate(sessionId)
    await flush()

    const spy = jest.spyOn(app.panel, "interrupt")
    const ev = fireWinKey(".", { metaKey: true })
    expect(ev.preventDefault).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("opens #tiles deep link on boot and recovers via showUnavailable if store.start rejects", async () => {
    const { root: rootTiles } = installDom("?demo=1", "#tiles")
    const app = (await boot(rootTiles as any))!
    expect(app).toBeDefined()
    handles.push(app)
    expect(app.tiles.isOpen).toBe(true)
    app.destroy()

    const { root: rootErr } = installDom("")
    ;(globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({ mode: "live", connected: true, userHome: "/Users/you" }),
    })
    const startSpy = jest.spyOn(Store.prototype, "start").mockRejectedValueOnce(new Error("store crashed"))
    try {
      const failed = await boot(rootErr as any)
      expect(failed).toBeUndefined()
      expect(winHandlers["keydown"] ?? []).toHaveLength(0)
      expect(rootErr.querySelector("h1")!.textContent).toBe("Can't reach Hermes")
      expect(rootErr.querySelector("p")!.textContent).toBe("store crashed")
    } finally {
      startSpy.mockRestore()
    }
  })

  it("handles filter chips, mark-reviewed, allow-all, search bar, dock controls, and attention jumps", async () => {
    const { root } = installDom("?demo=1")
    const app = (await boot(root as any))!
    handles.push(app)
    driveRaf()

    // Status chip filtering + mark all reviewed + allow all waiting
    const reviewChip = root.querySelector(".chip.review")!
    reviewChip.click()
    expect(app.canvas.filter).toBe("review")
    expect(reviewChip.attrs["aria-pressed"]).toBe("true")
    const markAll = root.querySelectorAll(".chip-action").find((b) => b.textContent.includes("Mark all reviewed"))!
    markAll.click()
    fireWinKey("Escape") // clears filter
    expect(app.canvas.filter).toBeUndefined()

    const allowAll = root.querySelector(".chip-action.allow")!
    allowAll.click()
    await flush()

    // Dock layout / spinner / wallpaper segments & 1-4 / 0 / = / - shortcuts
    const segBtns = root.querySelectorAll(".seg-btn")
    segBtns[0]?.click()
    fireWinKey("2")
    expect(app.canvas.layoutMode).toBe("fold")
    fireWinKey("0")
    fireWinKey("=")
    fireWinKey("-")
    fireWinKey("]")
    fireWinKey("[")

    // Search shortcut '/', typing, Escape clearing query
    fireWinKey("/")
    const searchInput = root.querySelector(".search input")!
    searchInput.value = "demo"
    searchInput.fire("input")
    jest.advanceTimersByTime(100)
    fireWinKey("Escape")
    expect(searchInput.value).toBe("")
  })
})
