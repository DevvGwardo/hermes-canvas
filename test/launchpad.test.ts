import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import type { Backend } from "../src/app/backend"
import { Launchpad } from "../src/app/launchpad"
import { Store } from "../src/app/store"
import type { Session } from "../src/app/types"

// Launchpad DOM tests: the real launch path (create row -> prompt -> mission
// strip), team/solo prompt composition, @project routing, and failure repair.
// FakeEl is the same minimal shim used by panel/tiles tests.

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
  placeholder = ""
  spellcheck = false
  style = new FakeStyle()
  dataset: Record<string, string> = {}
  attrs: Record<string, string> = {}
  children: FakeEl[] = []
  parent: FakeEl | null = null
  handlers: Record<string, Array<(e: any) => void>> = {}
  scrollHeight = 0
  disabled = false

  constructor(tag: string) {
    this.tag = tag
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
  scrollIntoView() {}
}

const saved: Record<string, any> = {}

function installStorage(seed: Record<string, string> = {}) {
  const data: Record<string, string> = { ...seed }
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (k in data ? data[k]! : null),
    setItem: (k: string, v: string) => void (data[k] = v),
    removeItem: (k: string) => void delete data[k],
  }
  return data
}

function mkSession(id: string, directory: string): Session {
  const now = Date.now()
  return {
    id,
    projectID: "p1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now, updated: now },
    title: "Existing work",
    location: { directory },
  }
}

function fixture(over: { selected?: string; home?: string; failPrompt?: boolean } = {}) {
  const created: Array<{ directory: string; permissions?: unknown }> = []
  const prompts: Array<{ id: string; text: string }> = []
  const opened: string[] = []
  const state = { failPrompt: !!over.failPrompt }

  const backend = {
    listProjects: async () => [{ id: "p1", name: "hermes-canvas", canonical: "/repo/hermes-canvas" }],
    listSessions: async () => [mkSession("seen", "/repo/hermes-canvas")],
    active: async () => new Set<string>(),
    listFolders: async () => [],
    createSession: async (directory: string, _model?: unknown, permissions?: unknown) => {
      created.push({ directory, permissions })
      return mkSession("new", directory)
    },
    prompt: async (id: string, input: { text: string }) => {
      if (state.failPrompt) throw new Error("launch failed")
      prompts.push({ id, text: input.text })
    },
  } as unknown as Backend

  const store = new Store(backend)
  const host = new FakeEl("div")
  const lp = new Launchpad(host as any, store, backend, {
    home: over.home ?? "/home/t",
    selectedDirectory: () => over.selected ?? "/repo/hermes-canvas",
    openSession: (id) => opened.push(id),
  })
  return { lp, store, backend, created, prompts, opened, host, state }
}

beforeEach(() => {
  jest.useFakeTimers()
  for (const k of ["document", "localStorage", "requestAnimationFrame"])
    saved[k] = (globalThis as any)[k]
  const doc = {
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => {
      const n = new FakeEl("#text")
      n.textContent = t
      return n
    },
    body: new FakeEl("body"),
    documentElement: new FakeEl("html"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  ;(globalThis as any).document = doc
  ;(globalThis as any).requestAnimationFrame = () => 0
})

afterEach(() => {
  for (const k of Object.keys(saved)) (globalThis as any)[k] = saved[k]
  jest.useRealTimers()
})

describe("Launchpad", () => {
  it("launches a team in the mentioned project and records the mission", async () => {
    installStorage()
    const { lp, store, created, prompts, opened } = fixture()
    await store.reload()
    ;(lp as any).input.value = "@hermes-canvas fix the flaky test"
    await (lp as any).launch()

    expect(created).toHaveLength(1)
    expect(created[0]!.directory).toBe("/repo/hermes-canvas")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.text.startsWith("fix the flaky test")).toBe(true)
    expect(prompts[0]!.text).toContain("delegate_task")
    expect((lp as any).input.value).toBe("")

    const missions = JSON.parse((globalThis as any).localStorage.getItem("hermes-canvas.missions"))
    expect(missions).toHaveLength(1)
    expect(missions[0].prompt).toBe("fix the flaky test")
    expect((lp as any).feed.children).toHaveLength(1)

    ;(lp as any).feed.children[0].click()
    expect(opened).toEqual(["new"])
  })

  it("drops the team wrapper in Solo mode", async () => {
    installStorage()
    const { lp, store, prompts } = fixture()
    await store.reload()
    ;(lp as any).setTeam(false)
    ;(lp as any).input.value = "run one agent"
    await (lp as any).launch()
    expect(prompts[0]!.text).toBe("run one agent")
  })

  it("restores the typed task and keeps a created session reachable when prompting fails", async () => {
    installStorage()
    const { lp, store, prompts, state } = fixture({ failPrompt: true })
    await store.reload()
    state.failPrompt = true
    ;(lp as any).input.value = "keep this text"
    await (lp as any).launch()
    expect(prompts).toHaveLength(0)
    expect((lp as any).input.value).toBe("keep this text")
    const missions = JSON.parse((globalThis as any).localStorage.getItem("hermes-canvas.missions"))
    expect(missions).toHaveLength(1)
    expect(missions[0].id).toBe("new")
    expect(missions[0].failed).toBe(true)
  })

  it("honours a persisted Solo choice", async () => {
    installStorage({ "hermes-canvas.launch.team": "0" })
    const { lp, store, prompts } = fixture()
    await store.reload()
    ;(lp as any).input.value = "solo please"
    await (lp as any).launch()
    expect(prompts[0]!.text).toBe("solo please")
  })

  it("falls back to the selected card when no destination was pinned", async () => {
    installStorage()
    const { lp, store, created } = fixture({ selected: "/repo/other" })
    await store.reload()
    ;(lp as any).input.value = "work elsewhere"
    await (lp as any).launch()
    expect(created[0]!.directory).toBe("/repo/other")
  })

  it("passes the allow-everything rule when Auto-approve is on", async () => {
    installStorage()
    const { lp, store, created } = fixture()
    await store.reload()
    store.setAutoApproveAll(true)
    ;(lp as any).input.value = "trusted task"
    await (lp as any).launch()
    expect(created[0]!.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }])
  })

  it("accepts a typed ~ folder in the destination menu", async () => {
    installStorage()
    const { lp, store } = fixture({ home: "/home/t" })
    await store.reload()
    ;(lp as any).destBtn.click()
    const menu = (lp as any).menu
    const filter = menu.children[0]
    filter.value = "~/code/app"
    filter.fire("input")
    filter.fire("keydown", { key: "Enter" })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect((lp as any).directory).toBe("/home/t/code/app")
    expect((lp as any).menu).toBeUndefined()
  })
})
