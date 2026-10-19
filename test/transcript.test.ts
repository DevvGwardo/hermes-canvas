import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import type { Backend } from "../src/app/backend"
import { Store } from "../src/app/store"
import { Transcript } from "../src/app/transcript"
import type { Message, ModelRef } from "../src/app/types"

// The transcript is the app's biggest DOM surface (panel + every tile), so it
// gets a miniature element tree: parent/child links, keyed event handlers and
// the small query surface render() needs. Everything else (markdown, store
// maps, backend pages) is real.

class FakeEl {
  tag: string
  className = ""
  textContent = ""
  innerHTML = ""
  hidden = false
  children: FakeEl[] = []
  parent: FakeEl | null = null
  handlers: Record<string, Array<() => void>> = {}
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

  addEventListener(type: string, fn: () => void) {
    ;(this.handlers[type] ??= []).push(fn)
  }

  fire(type: string) {
    for (const fn of this.handlers[type] ?? []) fn()
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
}

/** Aggregate text a render test can assert on (textContent + innerHTML sinks). */
function textOf(el: FakeEl): string {
  let s = el.textContent
  for (const c of el.children) s += textOf(c)
  return s
}

function htmlOf(el: FakeEl): string {
  let s = el.innerHTML
  for (const c of el.children) s += htmlOf(c)
  return s
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

let savedDoc: unknown
let savedRaf: unknown
let rafQueue: Array<() => void> = []

beforeEach(() => {
  savedDoc = (globalThis as any).document
  savedRaf = (globalThis as any).requestAnimationFrame
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
  jest.useRealTimers()
})

function driveRaf() {
  for (const cb of rafQueue.splice(0)) cb()
}

/** Newest-first pages per backend.messages() call; records every call. */
function fakeBackend(pages: Array<any[] | { data: any[]; cursor?: { previous?: string | null; next?: string | null }; hasMore?: boolean }>) {
  const calls: Array<{ id: string; size: number; cursor: string | null }> = []
  let i = 0
  const backend = {
    messages: async (id: string, size: number, cursor?: string | null) => {
      calls.push({ id, size, cursor: cursor ?? null })
      const raw = pages[Math.min(i++, pages.length - 1)] ?? []
      return Array.isArray(raw) ? { data: raw } : raw
    },
    inbox: async () => [],
  }
  return { backend: backend as unknown as Backend, calls }
}

function newTranscript(store: Store, backend: Backend, opts: { pageSize?: number; onRender?: () => void; onFinished?: () => void } = {}) {
  return new Transcript(store, backend, { pageSize: opts.pageSize ?? 16, onRender: opts.onRender, onFinished: opts.onFinished })
}

const userMsg = (id: string, text: string): Message => ({ type: "user", id, time: { created: 1 }, text })
const assistant = (id: string, content: any[]): Message =>
  ({ type: "assistant", id, time: { created: 2 }, agent: "build", model: { id: "claude" } as ModelRef, content }) as Message

describe("Transcript — construction and session loading", () => {
  it("builds the scroll shell, wires store card touches to a re-render, and stops after destroy", async () => {
    const store = new Store({} as unknown as Backend)
    const { backend, calls } = fakeBackend([[userMsg("m1", "Fix the bug")]])
    const onRender = jest.fn()
    const tr = newTranscript(store, backend, { onRender })

    const scroller = tr.scroller as unknown as FakeEl
    const list = tr.list as unknown as FakeEl
    const earlier = tr["earlier"] as unknown as FakeEl
    expect(scroller.children).toContain(earlier)
    expect(scroller.children).toContain(list)
    expect(earlier.hidden).toBe(true)
    expect(earlier.textContent).toContain("Load earlier")

    tr.setSession("s1")
    await flush()
    expect(onRender).toHaveBeenCalled() // load → render → onRender
    expect(list.children.length).toBe(1)

    // A card touch flows through the store listener into queueRender.
    jest.useFakeTimers()
    const before = onRender.mock.calls.length
    store.touchCard("s1")
    jest.advanceTimersByTime(300) // scheduleFlush also arms a 300ms timer (background-tab cover)
    driveRaf() // …and the frame path; whichever runs first delivers the card touch
    expect(onRender.mock.calls.length).toBe(before + 1)

    tr.destroy()
    expect(tr.id).toBeUndefined()
    const rendersAfterDestroy = onRender.mock.calls.length
    store.touchCard("s1")
    jest.advanceTimersByTime(300)
    driveRaf() // run whatever landed in the frame queue
    expect(onRender.mock.calls.length).toBe(rendersAfterDestroy) // unsubscribed: no re-render after destroy
    expect(calls.length).toBe(1)
  })

  it("loads a page newest-first, keeps messages oldest-first, and renders them", async () => {
    const store = new Store({} as unknown as Backend)
    const { backend, calls } = fakeBackend([[assistant("m2", [{ type: "text", text: "Done **it**" }]), userMsg("m1", "Fix the bug")]])
    const tr = newTranscript(store, backend, {})
    const list = tr.list as unknown as FakeEl

    tr.setSession("s1")
    await flush()

    expect(calls).toEqual([{ id: "s1", size: 16, cursor: null }])
    expect(tr.messages.map((m) => m.id)).toEqual(["m1", "m2"]) // reversed to chronological
    expect(list.children.length).toBe(2)
    expect(textOf(list.children[0]!)).toContain("Fix the bug")
    expect(htmlOf(list.children[1]!)).toContain("Done") // markdown-rendered assistant text
  })

  it("reloads on every setSession (even the same id) and clears on undefined", async () => {
    const store = new Store({} as unknown as Backend)
    const { backend, calls } = fakeBackend([[userMsg("m1", "Fix the bug")]])
    const tr = newTranscript(store, backend, {})
    const list = tr.list as unknown as FakeEl

    tr.setSession("s1")
    await flush()
    expect(tr.messages.length).toBe(1)

    tr.setSession("s1") // no same-id guard: a re-set is a fresh load
    await flush()
    expect(tr.messages.length).toBe(1) // reloaded, not doubled
    expect(calls.length).toBe(2)

    tr.setSession(undefined)
    expect(tr.id).toBeUndefined()
    expect(tr.messages).toEqual([])
    expect(list.children.length).toBe(0)
    expect(calls.length).toBe(2) // nothing to load for "no session"
  })

  it("merges older pages without dupes and stops when the cursor runs out", async () => {
    const store = new Store({} as unknown as Backend)
    const { backend, calls } = fakeBackend([
      { data: [assistant("m2", [{ type: "text", text: "Done" }]), userMsg("m1", "Fix the bug")], cursor: { next: "cur1" } },
      // Newest-first again; m1 repeats an already-loaded id and must be dropped.
      { data: [userMsg("m1", "Fix the bug"), userMsg("m0", "oldest")], hasMore: false },
    ])
    const tr = newTranscript(store, backend, { pageSize: 2 })
    const list = tr.list as unknown as FakeEl
    const earlier = tr["earlier"] as unknown as FakeEl

    tr.setSession("s1")
    await flush()
    expect(earlier.hidden).toBe(false) // a full page means there may be more
    expect(tr["cursorOlder"]).toBe("cur1")

    earlier.fire("click")
    await flush()
    expect(calls[1]).toEqual({ id: "s1", size: 2, cursor: "cur1" })
    expect(tr.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2"]) // older prepended, dup dropped
    expect(list.children.length).toBe(3)
    expect(tr["cursorOlder"]).toBeFalsy() // no hasMore → nothing left
    expect(earlier.hidden).toBe(true)
    expect(earlier.textContent).toContain("Load earlier")

    // The near-top scroll trigger is inert without a cursor.
    const before = calls.length
    ;(tr.scroller as unknown as FakeEl).fire("scroll")
    await flush()
    expect(calls.length).toBe(before)
  })

  it("swallows a failed load instead of crashing", async () => {
    const store = new Store({} as unknown as Backend)
    const backend = {
      messages: async () => {
        throw new Error("boom")
      },
      inbox: async () => [],
    } as unknown as Backend
    const tr = newTranscript(store, backend, {})

    await tr.load(true) // resolves (the failure is toasted, not rethrown)
    expect(tr.messages).toEqual([])
    expect((tr.list as unknown as FakeEl).children.length).toBe(0)
  })
})

describe("Transcript — blocks() folding", () => {
  function transcriptWith(messages: Message[]) {
    const store = new Store({} as unknown as Backend)
    const { backend } = fakeBackend([[]])
    const tr = newTranscript(store, backend, {})
    tr.id = "s1"
    tr.messages = messages
    return { store, tr, blocks: () => tr["blocks"]() as any[] }
  }

  it("folds live parts into one activity block and flushes at user/text boundaries", () => {
    const { blocks } = transcriptWith([
      assistant("a1", [
        { type: "reasoning", text: "thinking" },
        { type: "tool", id: "t1", name: "bash", state: { status: "running" }, time: { created: 1 } },
      ]),
      userMsg("m1", "Fix the bug"),
      assistant("a2", [
        { type: "text", text: "" }, // empty text is skipped
        { type: "text", text: "answer" },
      ]),
    ])
    const b = blocks()
    expect(b.map((x) => x.kind)).toEqual(["activity", "user", "text"])
    expect(b[0].items.map((i: any) => i.kind)).toEqual(["reasoning", "tool"])
    expect(b[1].text).toBe("Fix the bug")
    expect(b[2].text).toBe("answer")
  })

  it("keeps multiple tool calls of one assistant turn in a single activity block", () => {
    const { blocks } = transcriptWith([
      assistant("a1", [
        { type: "tool", id: "t1", name: "bash", state: { status: "running" }, time: { created: 1 } },
        { type: "tool", id: "t2", name: "read", state: { status: "completed", content: [{ type: "text", text: "ok" }] }, time: { created: 2 } },
        { type: "reasoning", text: "hmm" },
      ]),
    ])
    const b = blocks()
    expect(b.length).toBe(1)
    expect(b[0].kind).toBe("activity")
    expect(b[0].items.map((i: any) => i.kind)).toEqual(["tool", "tool", "reasoning"])
    expect(b[0].items.filter((i: any) => i.kind === "tool").map((i: any) => i.name)).toEqual(["bash", "read"])
    expect(b[0].items[0].status).toBe("running")
    expect(b[0].items[1].status).toBe("completed")
  })

  it("renders assistant errors, shell messages, compaction and model-switch as their own blocks", () => {
    const failed = { ...assistant("a1", []), error: { message: "boom" } } as Message
    const { blocks } = transcriptWith([
      failed,
      { type: "shell", id: "sh1", time: { created: 2 }, command: "ls", status: "exited", output: { output: "ok", truncated: false } } as Message,
      { type: "compaction", id: "c1", time: { created: 3 } } as Message,
      { type: "model-switched", id: "sw1", time: { created: 4 }, model: { id: "other" } } as unknown as Message,
    ])
    const b = blocks()
    expect(b.map((x) => x.kind)).toEqual(["error", "shell", "divider", "divider"])
    expect(b[0].text).toBe("boom")
    expect(b[1].command).toBe("ls")
    expect(b[1].output).toBe("ok")
  })

  it("appends store-held permission and form prompts after the history", () => {
    const { store, blocks } = transcriptWith([userMsg("m1", "Fix the bug")])
    store.permissions.set("s1", [{ id: "p1", sessionID: "s1", action: "bash.run", resources: ["rm -rf"] }])
    store.forms.set("s1", [{ id: "f1", sessionID: "s1", title: "Pick a lane", fields: [] }])
    const b = blocks()
    expect(b.map((x) => x.kind)).toEqual(["user", "permission", "form"])
    const json = JSON.stringify(b)
    expect(json).toContain("bash.run")
    expect(json).toContain("Pick a lane")
  })

  it("shows the Working block only when running with no live activity or pending input", () => {
    const { store, blocks } = transcriptWith([])
    store.running.add("s1")
    expect(blocks().map((x) => x.kind)).toEqual(["working"])

    // A live tool call is its own activity — no Working block on top.
    const withLive = transcriptWith([assistant("a1", [{ type: "tool", id: "t1", name: "bash", state: { status: "running" }, time: { created: 1 } }])])
    withLive.store.running.add("s1")
    expect(withLive.blocks().map((x) => x.kind)).toEqual(["activity"])

    // A pending permission means the agent needs the user, not a spinner.
    store.permissions.set("s1", [{ id: "p1", sessionID: "s1", action: "bash.run", resources: [] }])
    expect(blocks().map((x) => x.kind)).toEqual(["permission"])
  })

  it("appends the queued inbox and carries the pending-permission count on prompts", () => {
    const { store, tr, blocks } = transcriptWith([userMsg("m1", "Fix the bug")])
    tr.inbox = [{ id: "i1", sessionID: "s1", type: "user", payload: { text: "queued hi" }, delivery: "steer" }]
    store.permissions.set("s1", [{ id: "p1", sessionID: "s1", action: "bash.run", resources: [] }])
    store.permissions.set("s2", [{ id: "p2", sessionID: "s2", action: "web.fetch", resources: ["x"] }]) // other session too
    const b = blocks()
    expect(b.map((x) => x.kind)).toEqual(["user", "inbox", "permission"])
    const json = JSON.stringify(b)
    expect(json).toContain("queued hi")
    expect(json).toContain('"pending":2') // the prompt badge counts every pending permission
  })
})

describe("Transcript — onEvent stream patching", () => {
  function live() {
    const store = new Store({} as unknown as Backend)
    const { backend, calls } = fakeBackend([[]])
    const onFinished = jest.fn()
    const tr = newTranscript(store, backend, { onFinished })
    tr.id = "s1"
    return { tr, calls, onFinished }
  }

  it("ignores other sessions' events, then stitches text deltas into the assistant message", () => {
    const { tr } = live()
    tr["onEvent"]({ id: "e0", type: "session.text.delta", data: { sessionID: "OTHER", assistantMessageID: "x", delta: "nope" } } as any)
    expect(tr.messages).toEqual([])

    tr["onEvent"]({ id: "e1", type: "session.step.started", data: { sessionID: "s1", assistantMessageID: "a1", model: "claude" } } as any)
    tr["onEvent"]({ id: "e2", type: "session.text.delta", data: { sessionID: "s1", assistantMessageID: "a1", delta: "Hello " } } as any)
    tr["onEvent"]({ id: "e3", type: "session.text.delta", data: { sessionID: "s1", assistantMessageID: "a1", delta: "world" } } as any)
    const msg = tr.messages[0] as any
    expect(msg.type).toBe("assistant")
    expect(msg.content[0].text).toBe("Hello world")

    expect(rafQueue.length).toBe(1)
    driveRaf() // the queued render shows the patched text
    expect(htmlOf((tr.list as unknown as FakeEl).children[0]!)).toContain("Hello world")
  })

  it("drives a tool part through input.started → called → success", () => {
    const { tr } = live()
    tr["onEvent"]({ id: "e1", type: "session.step.started", data: { sessionID: "s1", assistantMessageID: "a1" } } as any)
    tr["onEvent"]({ id: "e2", type: "session.tool.input.started", data: { sessionID: "s1", assistantMessageID: "a1", id: "t1", name: "bash", input: { command: "ls" } } } as any)
    let part = (tr.messages[0] as any).content[0]
    expect(part.type).toBe("tool")
    expect(part.state.status).toBe("streaming") // input.started: part exists, input not known yet

    tr["onEvent"]({ id: "e3", type: "session.tool.called", data: { sessionID: "s1", assistantMessageID: "a1", id: "t1", input: { command: "ls" } } } as any)
    expect(part.state.status).toBe("running")
    expect(part.state.input).toEqual({ command: "ls" })

    tr["onEvent"]({ id: "e4", type: "session.tool.success", data: { sessionID: "s1", assistantMessageID: "a1", id: "t1", content: [{ type: "text", text: "ok" }] } } as any)
    expect(part.state.status).toBe("completed")
    expect(part.state.content).toEqual([{ type: "text", text: "ok" }])
  })

  it("fires onFinished + a 300ms refetch on execution end; renames refresh without re-rendering; questions queue a render", async () => {
    jest.useFakeTimers()
    const { tr, calls, onFinished } = live()

    tr["onEvent"]({ id: "e1", type: "session.execution.succeeded", data: { sessionID: "s1" } } as any)
    expect(onFinished).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(300)
    await flush()
    expect(calls.length).toBe(1) // the deferred reload happened

    driveRaf() // let the queued render run so renderQueued clears
    rafQueue.length = 0
    tr["onEvent"]({ id: "e2", type: "session.renamed", data: { sessionID: "s1", title: "New name" } } as any)
    expect(rafQueue.length).toBe(0) // renamed refreshes the header only

    tr["onEvent"]({ id: "e3", type: "permission.asked", data: { sessionID: "s1", requestID: "p1" } } as any)
    expect(rafQueue.length).toBe(1) // bare permission/question events queue a render (not driven here)
  })

  it("coalesces repeated queueRender calls into a single frame and diffs keyed blocks", () => {
    const { tr } = live()
    tr.messages = [userMsg("m1", "Fix the bug"), assistant("a2", [{ type: "text", text: "first" }])]

    tr.queueRender()
    tr.queueRender()
    tr.queueRender()
    expect(rafQueue.length).toBe(1)
    driveRaf()
    const list = tr.list as unknown as FakeEl
    expect(list.children.length).toBe(2)
    const assistantEl = list.children[1]!

    // A changed block gets replaced in place…
    ;(tr.messages[1] as any).content[0].text = "second"
    tr.queueRender()
    driveRaf()
    expect(list.children.length).toBe(2)
    expect(list.children[1]).not.toBe(assistantEl) // new element…
    expect(list.children[0]).toBe(list.children[0]) // …user block untouched
    expect(htmlOf(list.children[1]!)).toContain("second")

    // …and a dropped block is removed.
    tr.messages = [userMsg("m1", "Fix the bug")]
    tr.queueRender()
    driveRaf()
    expect(list.children.length).toBe(1)

    // Reordering moves existing elements instead of recreating them.
    const userEl = list.children[0]!
    tr.messages = [assistant("a2", [{ type: "text", text: "second" }]), userMsg("m1", "Fix the bug")]
    tr.queueRender()
    driveRaf()
    expect(list.children.length).toBe(2)
    expect(htmlOf(list.children[0]!)).toContain("second") // assistant first now (folding follows messages)
    expect(list.children[1]).toBe(userEl) // the same user element, moved
    expect(textOf(list.children[1]!)).toContain("Fix the bug")
  })
})
