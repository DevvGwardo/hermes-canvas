import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { Backend } from "../src/app/backend"
import { Store } from "../src/app/store"
import { Transcript } from "../src/app/transcript"
import type { FormInfo, InboxItem, PermissionRequest, Session } from "../src/app/types"

// T24: the transcript's interactive prompt widgets - the inline permission
// buttons, question forms, queued-message affordances and activity rows.
// Same FakeEl tree as test/transcript.test.ts, extended with the surfaces
// these widgets touch: prepend, classList.toggle(force), event objects,
// input value/checked bags and a canvas getContext stub for the spinner.

class FakeEl {
  tag: string
  className = ""
  textContent = ""
  innerHTML = ""
  hidden = false
  title = ""
  // input-ish surfaces some widgets set/read
  type = ""
  value: any = ""
  step = ""
  placeholder = ""
  checked = false
  style: Record<string, any> = {}
  attrs: Record<string, string> = {}
  children: FakeEl[] = []
  parent: FakeEl | null = null
  handlers: Record<string, Array<(e: any) => void>> = {}
  scrollTop = 0
  scrollHeight = 0
  clientHeight = 0

  constructor(tag: string) {
    this.tag = tag
  }

  get firstElementChild(): FakeEl | null {
    return this.children[0] ?? null
  }

  get nextElementSibling(): FakeEl | null {
    if (!this.parent) return null
    const i = this.parent.children.indexOf(this)
    return this.parent.children[i + 1] ?? null
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

  prepend(...nodes: any[]) {
    const adopted = nodes.map((n) => (typeof n === "string" ? new FakeEl("#text") : n))
    for (const el of adopted) {
      el.parent?.removeChild(el)
      el.parent = this
    }
    this.children.unshift(...adopted)
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

  fire(type: string) {
    for (const fn of this.handlers[type] ?? []) fn({ preventDefault() {} })
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

function all(el: FakeEl, pred: (e: FakeEl) => boolean): FakeEl[] {
  const out: FakeEl[] = []
  for (const c of el.children) {
    if (pred(c)) out.push(c)
    out.push(...all(c, pred))
  }
  return out
}

function textOf(el: FakeEl): string {
  let s = el.textContent
  for (const c of el.children) s += textOf(c)
  return s
}

const byText = (root: FakeEl, re: RegExp) => all(root, (e) => e.tag === "button" && re.test(e.textContent))

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

let savedDoc: unknown
let savedRaf: unknown
let savedWindow: unknown
let rafQueue: Array<() => void> = []

beforeEach(() => {
  savedDoc = (globalThis as any).document
  savedRaf = (globalThis as any).requestAnimationFrame
  savedWindow = (globalThis as any).window
  ;(globalThis as any).window = { devicePixelRatio: 1 } // spinner() reads it
  ;(globalThis as any).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => {
      const n = new FakeEl("#text")
      n.textContent = t
      return n
    },
  }
  rafQueue = []
  ;(globalThis as any).requestAnimationFrame = (cb: () => void) => {
    rafQueue.push(cb)
    return rafQueue.length
  }
})

afterEach(() => {
  ;(globalThis as any).document = savedDoc
  ;(globalThis as any).requestAnimationFrame = savedRaf
  ;(globalThis as any).window = savedWindow
})

function driveRaf() {
  for (const cb of rafQueue.splice(0)) cb()
}

const NOW = Date.now()
const sess = (id: string, over: Record<string, any> = {}): Session =>
  ({
    id,
    projectID: "p1",
    cost: 0,
    tokens: {} as any,
    outcome: "succeeded",
    time: { created: NOW - 10_000, updated: NOW - 5_000 },
    location: { directory: "/home/t/a" },
    ...over,
  }) as unknown as Session

const req = (id: string, sessionID = "s1"): PermissionRequest => ({ id, sessionID, action: "bash.run", resources: ["rm -rf /x"] })

function widgetBackend(sessions: Session[] = [sess("s1")]) {
  const replies: Array<{ sessionID: string; requestID: string; decision: string }> = []
  const forms: Array<{ sessionID: string; id: string; answer: Record<string, unknown> }> = []
  const cancelled: Array<{ kind: string; sessionID: string; id: string }> = []
  const deliveries: Array<{ sessionID: string; id: string; delivery: string }> = []
  const sessionRules: Array<{ id: string; rules: any[] }> = []
  let failReply = false
  const backend = {
    listProjects: async () => [],
    listSessions: async () => sessions,
    active: async () => new Set<string>(),
    messages: async () => ({ data: [] }),
    inbox: async () => [],
    replyPermission: async (sessionID: string, requestID: string, decision: string) => {
      if (failReply) throw new Error("denied by server")
      replies.push({ sessionID, requestID, decision })
    },
    replyForm: async (sessionID: string, id: string, answer: Record<string, unknown>) => {
      forms.push({ sessionID, id, answer })
    },
    cancelForm: async (sessionID: string, id: string) => cancelled.push({ kind: "form", sessionID, id }),
    cancelInbox: async (sessionID: string, id: string) => cancelled.push({ kind: "inbox", sessionID, id }),
    setInboxDelivery: async (sessionID: string, id: string, delivery: string) => deliveries.push({ sessionID, id, delivery }),
    setSessionPermissions: async (id: string, rules: any[]) => sessionRules.push({ id, rules }),
  }
  return {
    backend: backend as unknown as Backend,
    replies,
    forms,
    cancelled,
    deliveries,
    sessionRules,
    setFailReply: (f: boolean) => {
      failReply = f
    },
  }
}

async function widgetTranscript(sessions: Session[] = [sess("s1")]) {
  const b = widgetBackend(sessions)
  const store = new Store(b.backend)
  await store.reload()
  const tr = new Transcript(store, b.backend, { pageSize: 16 })
  tr.id = "s1"
  return { tr, store, ...b, list: tr.list as unknown as FakeEl }
}

describe("Transcript — permission prompts", () => {
  it("renders the ask with resources and the four decisions; Allow once clears it", async () => {
    const { tr, store, list, replies } = await widgetTranscript()
    store.permissions.set("s1", [req("p1")])
    tr.render(false)
    const row = find(list, (e) => e.className.includes("msg ask"))!
    expect(textOf(row)).toContain("Allow bash.run?")
    expect(textOf(row)).toContain("rm -rf /x")
    expect(all(row, (e) => e.tag === "button").map((b) => b.textContent)).toEqual([
      "Allow once",
      "Always allow",
      "Allow everything in this session",
      "Reject",
    ])

    byText(row, /Allow once/)[0]!.fire("click")
    await flush()
    expect(replies).toEqual([{ sessionID: "s1", requestID: "p1", decision: "once" }])
    expect(store.permissions.get("s1")).toEqual([])
    tr.render(false)
    expect(find(list, (e) => e.className.includes("msg ask"))).toBeUndefined()
  })

  it("Reject sends the reject decision and also clears the prompt", async () => {
    const { tr, store, list, replies } = await widgetTranscript()
    store.permissions.set("s1", [req("p1")])
    tr.render(false)
    byText(find(list, (e) => e.className.includes("msg ask"))!, /Reject/)[0]!.fire("click")
    await flush()
    expect(replies[0]!.decision).toBe("reject")
    expect(store.permissions.has("s1") && store.permissions.get("s1")!.length > 0).toBe(false)
  })

  it("Allow everything writes the allow-all rule onto the session", async () => {
    const { tr, store, list, sessionRules } = await widgetTranscript()
    store.permissions.set("s1", [req("p1")])
    tr.render(false)
    byText(find(list, (e) => e.className.includes("msg ask"))!, /Allow everything/)[0]!.fire("click")
    await flush()
    expect(sessionRules).toHaveLength(1)
    expect(sessionRules[0]!.id).toBe("s1")
    expect(sessionRules[0]!.rules.some((r) => r.action === "*" && r.resource === "*" && r.effect === "allow")).toBe(true)
    expect(store.sessionAutoApproves("s1")).toBe(true)
  })

  it("offers Allow-all-waiting only when several requests wait, and clears every prompt", async () => {
    const { tr, store, list, replies } = await widgetTranscript()
    store.permissions.set("s1", [req("p1"), req("p2"), req("p3")])
    tr.render(false)
    const row = find(list, (e) => e.className.includes("msg ask"))!
    const allBtn = byText(row, /Allow all 3 waiting/)[0]!
    allBtn.fire("click")
    await flush()
    expect(replies.map((r) => r.requestID).sort()).toEqual(["p1", "p2", "p3"])
    expect(replies.every((r) => r.decision === "once")).toBe(true)
    expect(store.pendingPermissionCount()).toBe(0)
  })

  it("a failed decision leaves the prompt up and does not throw", async () => {
    const { tr, store, list, setFailReply } = await widgetTranscript()
    store.permissions.set("s1", [req("p1")])
    tr.render(false)
    setFailReply(true)
    byText(find(list, (e) => e.className.includes("msg ask"))!, /Allow once/)[0]!.fire("click")
    await flush()
    expect(store.permissions.get("s1")!.map((p) => p.id)).toEqual(["p1"]) // untouched: removal happens after the reply
  })
})

describe("Transcript — question forms", () => {
  const widgetForm = (): FormInfo => ({
    id: "f1",
    sessionID: "s1",
    title: "Pick a lane",
    fields: [
      { key: "name", type: "string", title: "Name", placeholder: "type here", default: "hi" },
      { key: "ratio", type: "number", default: 5 },
      { key: "count", type: "integer", default: 2 },
      { key: "loud", type: "boolean", default: true },
      { key: "tags", type: "multiselect", default: ["a"], options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
      { key: "mode", type: "string", default: "fast", options: [{ value: "fast", label: "Fast" }, { value: "slow", label: "Slow" }] },
      { key: "server", type: "external", title: "Server picks" },
      { key: "secret", type: "string", hidden: true, title: "Hidden field" },
    ],
  })

  it("renders every field type with defaults and skips hidden ones", async () => {
    const { tr, store, list } = await widgetTranscript()
    store.forms.set("s1", [widgetForm()])
    tr.render(false)
    const body = find(list, (e) => e.tag === "form")!
    expect(textOf(body)).toContain("Pick a lane")
    expect(all(body, (e) => e.tag === "input")[0]!.placeholder).toBe("type here") // property, not text
    expect(textOf(body)).not.toContain("Hidden field")

    const inputs = all(body, (e) => e.tag === "input")
    expect(inputs.map((i) => i.type)).toEqual(["text", "number", "number", "checkbox", "checkbox", "checkbox"])
    expect(inputs[0]!.value).toBe("hi")
    expect(inputs[1]!.value).toBe("5") // defaults arrive stringified
    expect(inputs[2]!.step).toBe("1")
    expect(inputs[3]!.checked).toBe(true) // boolean default
    expect(inputs[4]!.checked).toBe(true) // multiselect default includes "a"
    expect(inputs[5]!.checked).toBe(false)
    const select = find(body, (e) => e.tag === "select")!
    expect(select.value).toBe("fast")
    expect(textOf(body)).toContain("Answer this one in Hermes.") // external hint
  })

  it("submit gathers typed values, coercing numbers and dropping empties", async () => {
    const { tr, store, list, forms } = await widgetTranscript()
    store.forms.set("s1", [widgetForm()])
    tr.render(false)
    const body = find(list, (e) => e.tag === "form")!
    const inputs = all(body, (e) => e.tag === "input")
    inputs[0]!.value = "" // emptied string: dropped
    inputs[1]!.value = "" // emptied number: dropped
    inputs[2]!.value = "7" // integer as text -> number
    inputs[3]!.checked = false
    inputs[4]!.checked = false
    inputs[5]!.checked = true // pick "b" only
    find(body, (e) => e.tag === "select")!.value = "slow"
    body.fire("submit")
    await flush()
    expect(forms).toEqual([
      {
        sessionID: "s1",
        id: "f1",
        answer: { count: 7, loud: false, tags: ["b"], mode: "slow" }, // name/ratio empty, defaults replaced
      },
    ])
  })

  it("Dismiss cancels the form instead of answering it", async () => {
    const { tr, store, list, cancelled, forms } = await widgetTranscript()
    store.forms.set("s1", [widgetForm()])
    tr.render(false)
    byText(find(list, (e) => e.tag === "form")!, /Dismiss/)[0]!.fire("click")
    await flush()
    expect(cancelled).toEqual([{ kind: "form", sessionID: "s1", id: "f1" }])
    expect(forms).toEqual([])
  })
})

describe("Transcript — queued inbox rows", () => {
  const item = (id: string, delivery: "queue" | "steer"): InboxItem => ({
    id,
    sessionID: "s1",
    type: "user",
    payload: { text: "later message" },
    delivery,
  })

  it("queued items can be sent now or cancelled", async () => {
    const { tr, list, deliveries, cancelled } = await widgetTranscript()
    tr.inbox = [item("i1", "queue")]
    tr.render(false)
    const row = find(list, (e) => e.className.includes("msg inbox"))!
    expect(textOf(row)).toContain("Queued")
    byText(row, /Send now/)[0]!.fire("click")
    byText(row, /Cancel/)[0]!.fire("click")
    await flush()
    expect(deliveries).toEqual([{ sessionID: "s1", id: "i1", delivery: "steer" }])
    expect(cancelled).toEqual([{ kind: "inbox", sessionID: "s1", id: "i1" }])
  })

  it("steering items skip the Send now affordance", async () => {
    const { tr, list } = await widgetTranscript()
    tr.inbox = [item("i2", "steer")]
    tr.render(false)
    const row = find(list, (e) => e.className.includes("msg inbox"))!
    expect(textOf(row)).toContain("Steering")
    expect(byText(row, /Send now/)).toHaveLength(0)
    expect(byText(row, /Cancel/)).toHaveLength(1)
  })
})

describe("Transcript — activity rows", () => {
  const tool = (id: string, name: string, status: string, output?: string) => ({
    type: "tool",
    id,
    name,
    state: { status, input: { command: name + "-it" }, ...(output ? { output, content: [{ type: "text", text: output }] } : {}) },
    time: { created: 1, completed: status === "completed" ? 2 : undefined },
  })

  it("completed activity collapses to a twisty and expands into rows with output", async () => {
    const { tr, list } = await widgetTranscript()
    tr.messages = [
      {
        type: "assistant",
        id: "a1",
        time: { created: 1, completed: 2 },
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [tool("t1", "bash", "completed", "all good"), tool("t2", "read", "completed")],
      } as any,
    ]
    tr.render(false)
    const head = find(list, (e) => e.className.includes("activity-head"))!
    expect(head.attrs["aria-expanded"]).toBe("false")
    expect(find(head, (e) => e.className.includes("twisty"))!.textContent).toBe("+")
    expect(textOf(head).length).toBeGreaterThan(1) // twisty + summary text

    head.fire("click") // queues a re-render
    driveRaf()
    const listEl = find(tr.list as unknown as FakeEl, (e) => e.className.includes("activity-list"))!
    const rows = all(listEl, (e) => e.className.includes("activity-row"))
    expect(rows.length).toBe(2)
    const out = find(listEl, (e) => e.tag === "pre")!
    expect(out.hidden).toBe(true)
    rows[0]!.fire("click") // expand the output
    expect(out.hidden).toBe(false)
    expect(rows[0]!.className).toContain("open")
  })

  it("a running tool swaps the twisty for a spinner and names the live tool", async () => {
    const { tr, list } = await widgetTranscript()
    tr.messages = [
      {
        type: "assistant",
        id: "a1",
        time: { created: 1 },
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [tool("t1", "bash", "running")],
      } as any,
    ]
    tr.render(false)
    const head = find(list, (e) => e.className.includes("activity-head"))!
    expect(find(head, (e) => e.tag === "canvas")).toBeDefined() // spinner, not twisty
    expect(find(head, (e) => e.className.includes("twisty"))).toBeUndefined()
    expect(textOf(head)).toContain("bash") // describeTool names the live tool
  })
})

describe("Transcript — pending message rows", () => {
  const item = (n: number): InboxItem => ({
    id: `pend${n}`,
    sessionID: "s1",
    type: "user",
    payload: { text: `pending ${n}` },
    delivery: "steer",
  })

  it("addPending shows the row immediately; removePending drops exactly that one", async () => {
    const { tr, list } = await widgetTranscript()
    const p1 = item(1) // reference-based removal: same object in and out
    tr.addPending(p1)
    expect(textOf(list as unknown as FakeEl)).toContain("pending 1")
    tr.addPending(item(2))
    expect(all(list as unknown as FakeEl, (e) => e.className.includes("msg inbox")).length).toBe(2)
    tr.removePending(p1)
    const rows = all(list as unknown as FakeEl, (e) => e.className.includes("msg inbox"))
    expect(rows.length).toBe(1)
    expect(textOf(rows[0]!)).toContain("pending 2") // reference-based removal kept the other
  })
})
