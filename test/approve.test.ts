import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import { autoApprovedNotices, autoApproveToggle } from "../src/app/approve"
import type { Backend } from "../src/app/backend"
import { Store } from "../src/app/store"
import { toast } from "../src/app/toast"

// approve.ts carries the safety interlock around `--yolo` (README: "turning it
// on takes a confirming second click") and coalesces auto-approval notices into
// one toast per 600ms burst. None of that had a test. The real toast() runs
// against the fake document below, so asserted strings are what actually lands
// on screen. NOTE: `toggles` in approve.ts is a module-level Set that grows
// across tests - each button closes over its own store, so assertions target
// the button returned by its own call.

type FakeEl = {
  tag: string
  children: FakeEl[]
  attrs: Record<string, string>
  textContent: string
  title: string
  innerHTML: string
  handlers: Record<string, Array<(e: unknown) => void>>
  label?: FakeEl
  get className(): string
  set className(v: string)
  classList: {
    add(...cs: string[]): void
    remove(...cs: string[]): void
    toggle(c: string, force?: boolean): boolean
    contains(c: string): boolean
  }
  setAttribute(k: string, v: string): void
  addEventListener(t: string, fn: (e: unknown) => void): void
  append(...ns: FakeEl[]): void
  remove(): void
  querySelector(sel: string): FakeEl | null
}

function fakeEl(tag: string): FakeEl {
  const classes = new Set<string>()
  const el: FakeEl = {
    tag,
    children: [],
    attrs: {},
    textContent: "",
    title: "",
    innerHTML: "",
    handlers: {},
    get className() {
      return [...classes].join(" ")
    },
    set className(v: string) {
      classes.clear()
      for (const c of v.split(/\s+/).filter(Boolean)) classes.add(c)
    },
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, force) => {
        const want = force ?? !classes.has(c)
        if (want) classes.add(c)
        else classes.delete(c)
        return want
      },
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => {
      el.attrs[k] = v
    },
    addEventListener: (t, fn) => {
      ;(el.handlers[t] ??= []).push(fn)
    },
    append: (...ns) => el.children.push(...ns),
    remove: () => {},
    // approve.ts only ever asks for its label span; ignore the innerHTML it sets.
    querySelector: (sel) => (sel === ".aa-label" ? ((el.label ??= fakeEl("span"))) : null),
  }
  return el
}

const body = fakeEl("body")
const doc = {
  createElement: (tag: string) => fakeEl(tag),
  body,
}
const g = globalThis as Record<string, unknown>
const original = { document: g.document, requestAnimationFrame: g.requestAnimationFrame }

function toasts(): string[] {
  const host = body.children[0]
  return host ? host.children.map((t) => t.textContent) : []
}
function clearToasts() {
  const host = body.children[0]
  if (host) host.children.length = 0
}

interface FakeStore {
  autoApproveAll: boolean
  calls: string[]
  pending: number
  setAutoApproveAll(v: boolean): void
  pendingPermissionCount(): number
  sessions: Map<string, unknown>
  projectLabel(s: unknown): string
  onAutoApproved?: (req: { sessionID: string; action: string; resources?: string[] }) => void
}

function fakeStore(opts: { autoApprove?: boolean; pending?: number } = {}): FakeStore {
  const s: FakeStore = {
    autoApproveAll: opts.autoApprove ?? false,
    calls: [],
    pending: opts.pending ?? 0,
    setAutoApproveAll(v) {
      s.autoApproveAll = v
      s.calls.push(`set:${v}`)
    },
    pendingPermissionCount: () => s.pending,
    sessions: new Map([["ses_1", { id: "ses_1" }]]),
    projectLabel: () => "storefront",
  }
  return s
}

const click = (b: any) => b.handlers.click[0]({})
/** The real return type is HTMLButtonElement; tests read the fake's internals. */
const toggle = (s: FakeStore): FakeEl => autoApproveToggle(s as any) as unknown as FakeEl

beforeEach(() => {
  jest.useFakeTimers()
  g.document = doc
  // toast() paints via rAF; run it synchronously so no frame is ever pending.
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    cb(0)
    return 0
  }
  // Keep the toast host (toast.ts caches it module-level) - just empty it.
  clearToasts()
})

afterEach(() => {
  jest.useRealTimers()
  for (const key of ["document", "requestAnimationFrame"] as const) {
    if (original[key] === undefined) delete g[key]
    else g[key] = original[key]
  }
})

test("starts off with the resting label, aria state, and title", () => {
  const store = fakeStore()
  const b = toggle(store)
  expect(b.classList.contains("on")).toBe(false)
  expect(b.classList.contains("confirming")).toBe(false)
  expect(b.label!.textContent).toBe("Auto-approve")
  expect(b.attrs["aria-pressed"]).toBe("false")
  expect(b.title).toContain("Approve every permission request automatically")
})

test("first click NEVER enables: it only arms the confirm state", () => {
  const store = fakeStore()
  const b = toggle(store)
  click(b)
  expect(store.calls).toEqual([]) // no store write at all
  expect(store.autoApproveAll).toBe(false)
  expect(b.classList.contains("confirming")).toBe(true)
  expect(b.label!.textContent).toBe("Click again: allow everything?")
  expect(toasts()).toEqual([]) // silent while armed
})

test("the armed confirm expires after 4s without enabling", () => {
  const store = fakeStore()
  const b = toggle(store)
  click(b)
  jest.advanceTimersByTime(4000)
  expect(store.autoApproveAll).toBe(false)
  expect(b.classList.contains("confirming")).toBe(false)
  expect(b.label!.textContent).toBe("Auto-approve")
  // and it must arm cleanly again afterwards
  click(b)
  expect(b.classList.contains("confirming")).toBe(true)
})

test("second click inside the window enables, with the no-pending toast", () => {
  const store = fakeStore({ pending: 0 })
  const b = toggle(store)
  click(b)
  jest.advanceTimersByTime(1000) // still inside the 4s window
  click(b)
  expect(store.calls).toEqual(["set:true"])
  expect(b.classList.contains("confirming")).toBe(false)
  expect(b.classList.contains("on")).toBe(true)
  expect(b.label!.textContent).toBe("Auto-approve on")
  expect(b.attrs["aria-pressed"]).toBe("true")
  expect(toasts()).toEqual(["Auto-approve on"])
})

test("enabling reports waiting requests, singular and plural", () => {
  const one = fakeStore({ pending: 1 })
  const b1 = toggle(one)
  click(b1)
  click(b1)
  expect(toasts()).toEqual(["Auto-approve on: approved 1 waiting request"])
  clearToasts()

  const three = fakeStore({ pending: 3 })
  const b3 = toggle(three)
  click(b3)
  click(b3)
  expect(toasts()).toEqual(["Auto-approve on: approved 3 waiting requests"])
})

test("clicking while on disables and announces the mode change", () => {
  const store = fakeStore({ autoApprove: true })
  const b = toggle(store)
  expect(b.classList.contains("on")).toBe(true)
  expect(b.label!.textContent).toBe("Auto-approve on")
  expect(b.attrs["aria-pressed"]).toBe("true")
  click(b)
  expect(store.calls).toEqual(["set:false"])
  expect(b.classList.contains("on")).toBe(false)
  expect(b.label!.textContent).toBe("Auto-approve")
  expect(toasts()).toEqual(["Auto-approve off: sessions will ask again"])
})

test("autoApprovedNotices wires the store callback", () => {
  const store = fakeStore()
  autoApprovedNotices(store as any)
  expect(typeof store.onAutoApproved).toBe("function")
  expect(toasts()).toEqual([]) // wiring alone announces nothing
})

test("a burst of approvals becomes ONE count toast after 600ms", () => {
  const store = fakeStore()
  autoApprovedNotices(store as any)
  for (let i = 0; i < 3; i++) store.onAutoApproved!({ sessionID: "ses_1", action: "Read", resources: [`/tmp/f${i}`] })
  expect(toasts()).toEqual([]) // nothing yet: the window is still open
  jest.advanceTimersByTime(600)
  expect(toasts()).toEqual(["Auto-approved 3 requests"])
  expect(store.onAutoApproved).toBeDefined()
})

test("a lone approval names the action, resource, and project", () => {
  const store = fakeStore()
  autoApprovedNotices(store as any)
  store.onAutoApproved!({ sessionID: "ses_1", action: "Bash", resources: ["git push"] })
  jest.advanceTimersByTime(600)
  expect(toasts()).toEqual(["Auto-approved Bash git push (storefront)"])
  clearToasts()
  // unknown session falls back to the generic locator
  store.onAutoApproved!({ sessionID: "ses_gone", action: "Bash", resources: ["ls"] })
  jest.advanceTimersByTime(600)
  expect(toasts()).toEqual(["Auto-approved Bash ls (a session)"])
})

test("long descriptions truncate at 47 chars + ellipsis before the locator", () => {
  const store = fakeStore()
  autoApprovedNotices(store as any)
  const longCmd = "find / -type f -name '*.log' -delete --verbose --pretend"
  store.onAutoApproved!({ sessionID: "ses_1", action: "Bash", resources: [longCmd] })
  jest.advanceTimersByTime(600)
  const [msg] = toasts()
  const bodyText = msg.replace(/^Auto-approved /, "")
  const inside = bodyText.slice(bodyText.lastIndexOf(" (")) // " (storefront)"
  const what = bodyText.slice(0, bodyText.lastIndexOf(" ("))
  expect(inside).toBe(" (storefront)")
  expect(what.length).toBe(48)
  expect(what.endsWith("…")).toBe(true)
})

test("a second burst after the window opens its own toast", () => {
  const store = fakeStore()
  autoApprovedNotices(store as any)
  store.onAutoApproved!({ sessionID: "ses_1", action: "Read", resources: ["/etc/hosts"] })
  jest.advanceTimersByTime(600)
  expect(toasts()).toEqual(["Auto-approved Read /etc/hosts (storefront)"])
  store.onAutoApproved!({ sessionID: "ses_1", action: "Read", resources: ["/etc/passwd"] })
  jest.advanceTimersByTime(600)
  expect(toasts()).toEqual([
    "Auto-approved Read /etc/hosts (storefront)",
    "Auto-approved Read /etc/passwd (storefront)",
  ])
})

test("a toast fades itself out when its window expires", () => {
  toast("deployed", 500)
  const t = body.children[0].children.at(-1)!
  expect(t.classList.contains("in")).toBe(true) // the rAF stub paints it synchronously
  jest.advanceTimersByTime(499)
  expect(t.classList.contains("in")).toBe(true) // still on screen just before its window
  jest.advanceTimersByTime(1)
  expect(t.classList.contains("in")).toBe(false) // the expiry timer removes the enter class
})

test("isolates toggles across stores, sets button type, and syncs external store updates", () => {
  const s1 = fakeStore()
  const s2 = fakeStore()
  const b1 = toggle(s1) as any
  const b2 = toggle(s2) as any
  expect(b1.type).toBe("button")
  expect(b2.type).toBe("button")

  click(b1)
  click(b1)
  expect(s1.autoApproveAll).toBe(true)
  expect(s2.autoApproveAll).toBe(false)
  expect(b1.classList.contains("on")).toBe(true)
  expect(b2.classList.contains("on")).toBe(false)
  expect(b2.label.textContent).toBe("Auto-approve")

  const realStore = new Store({ kind: "demo" } as unknown as Backend)
  const liveBtn = autoApproveToggle(realStore) as unknown as FakeEl & { isConnected: boolean }
  const detachedBtn = autoApproveToggle(realStore) as unknown as FakeEl & { isConnected: boolean }
  liveBtn.isConnected = true
  detachedBtn.isConnected = true
  realStore.setAutoApproveAll(true)
  expect(liveBtn.classList.contains("on")).toBe(true)
  expect(detachedBtn.classList.contains("on")).toBe(true)

  detachedBtn.isConnected = false
  realStore.setAutoApproveAll(false)
  expect(liveBtn.classList.contains("on")).toBe(false)
  expect(detachedBtn.classList.contains("on")).toBe(true) // disconnected toggle was pruned
})

test("autoApprovedNotices handles empty resources and cleanup cancels pending bursts", () => {
  const store = fakeStore()
  const dispose = autoApprovedNotices(store as any)
  store.onAutoApproved!({ sessionID: "ses_1", action: "bash", resources: [] })
  jest.advanceTimersByTime(600)
  expect(toasts()).toEqual(["Auto-approved bash (storefront)"])
  clearToasts()

  store.onAutoApproved!({ sessionID: "ses_1", action: "read", resources: ["/tmp/a"] })
  dispose()
  jest.advanceTimersByTime(600)
  expect(toasts()).toEqual([])
  expect(store.onAutoApproved).toBeUndefined()
})
