import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Backend } from "../src/app/backend"
import { createNewCard, createSessionCard, updateSessionCard } from "../src/app/card"
import { Store } from "../src/app/store"
import type { PermissionRequest, Session } from "../src/app/types"

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
  style = new FakeStyle()
  dataset: Record<string, string> = {}
  attrs: Record<string, string> = {}
  children: FakeEl[] = []
  parent: FakeEl | null = null
  scrollHeight = 40
  clientHeight = 92
  private html = ""

  constructor(tag: string) {
    this.tag = tag
  }

  get innerHTML() {
    return this.html
  }

  set innerHTML(v: string) {
    this.html = v
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
    for (const el of nodes) {
      el.parent = this
      this.children.push(el)
    }
  }

  replaceChildren(...nodes: FakeEl[]) {
    this.children = []
    this.append(...nodes)
  }

  setAttribute(k: string, v: string) {
    this.attrs[k] = v
  }

  getAttribute(k: string) {
    return this.attrs[k]
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

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}

beforeEach(() => {
  for (const k of ["document", "window", "requestAnimationFrame"]) saved[k] = g[k]
  g.document = { createElement: (tag: string) => new FakeEl(tag) }
  g.window = { devicePixelRatio: 1 }
  g.requestAnimationFrame = () => 0
})

afterEach(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete g[k]
    else g[k] = saved[k]
  }
})

const NOW = 1_700_000_000_000
const mk = (id: string, over: Record<string, any> = {}): Session =>
  ({
    id,
    projectID: "p1",
    title: `Session ${id}`,
    cost: 0,
    tokens: {} as any,
    outcome: "succeeded",
    time: { created: NOW - 300_000, updated: NOW - 10_000, idle: NOW - 10_000, ...over.time },
    location: { directory: "/repo/app", ...over.location },
    ...over,
  }) as unknown as Session

function makeStore(sessions: Session[]) {
  const backend = {
    listProjects: async () => [],
    listSessions: async () => sessions,
    active: async () => new Set<string>(),
    messages: async () => ({ data: [] }),
    inbox: async () => [],
    markViewed: async () => {},
  } as unknown as Backend
  const store = new Store(backend)
  for (const s of sessions) store.sessions.set(s.id, s)
  store["rebuildChildren"]()
  return store
}

describe("card DOM helpers", () => {
  test("createNewCard builds placeholder card with dataset and accessibility attrs", () => {
    const el = createNewCard("g1") as unknown as FakeEl
    expect(el.className).toBe("card card-new")
    expect(el.dataset.id).toBe("new:g1")
    expect(el.dataset.group).toBe("g1")
    expect(el.getAttribute("role")).toBe("button")
    expect(el.innerHTML).toContain("New session")
  })

  test("updateSessionCard renders status variants, previews, live text, subagents, and clipped mask", () => {
    const s = mk("s1", { time: { created: NOW - 60_000, updated: NOW - 5_000 } })
    const child = mk("c1", { parentID: "s1" })
    const store = makeStore([s, child])
    const card = createSessionCard("s1")
    expect((card.root as unknown as FakeEl).tabIndex).toBe(-1)
    expect((card.root as unknown as FakeEl).getAttribute("role")).toBe("button")

    // Missing session returns false cleanly
    expect(updateSessionCard(card, store, "missing", NOW)).toBe(false)

    // Working + pendingUser + liveText + clipped
    store.running.add("s1")
    store["activity"].set("s1", "Running bash")
    store.previews.set("s1", { text: "old", bullets: ["a"], pendingUser: "wait" })
    store.liveText.set("s1", "First line\n\n- step one")
    ;(card.body as unknown as FakeEl).scrollHeight = 140
    ;(card.body as unknown as FakeEl).clientHeight = 92

    expect(updateSessionCard(card, store, "s1", NOW)).toBe(true)
    expect(card.root.classList.contains("st-working")).toBe(true)
    expect(card.root.classList.contains("has-sub")).toBe(true)
    expect(card.sub.textContent).toBe("1 subagent")
    expect(card.text.textContent).toBe("First line")
    expect((card.bullets as unknown as FakeEl).children.length).toBe(1)
    expect(card.body.classList.contains("clipped")).toBe(true)
    expect((card.status as unknown as FakeEl).querySelector(".label")!.textContent).toBe("Running bash")

    // Subsequent tick where only activity text or `now` changes does NOT mark heightChanged (C13)
    store["activity"].set("s1", "Editing file")
    expect(updateSessionCard(card, store, "s1", NOW + 30_000)).toBe(false)
    expect((card.status as unknown as FakeEl).querySelector(".label")!.textContent).toBe("Editing file")

    // Changing bullets/body marks heightChanged = true
    store.liveText.set("s1", "Updated stream\n- b1\n- b2")
    expect(updateSessionCard(card, store, "s1", NOW + 30_000)).toBe(true)

    // Needs-you (permission vs question)
    store.running.delete("s1")
    store.permissions.set("s1", [{ id: "p1", sessionID: "s1", action: "read", resources: [] } as PermissionRequest])
    expect(updateSessionCard(card, store, "s1", NOW)).toBe(true) // leaving working changes height
    expect(card.root.classList.contains("st-needs-you")).toBe(true)
    expect((card.status as unknown as FakeEl).querySelector(".label")!.textContent).toBe("Needs permission")

    store.permissions.delete("s1")
    store.forms.set("s1", [{ id: "f1", sessionID: "s1", title: "?", fields: [] }])
    updateSessionCard(card, store, "s1", NOW)
    expect((card.status as unknown as FakeEl).querySelector(".label")!.textContent).toBe("Waiting for your answer")

    // Failed + fresh inside review window
    store.forms.delete("s1")
    s.outcome = "failed"
    s.time.idle = NOW - 10_000
    updateSessionCard(card, store, "s1", NOW)
    expect(card.root.classList.contains("st-failed")).toBe(true)
    expect(card.root.classList.contains("fresh")).toBe(true)

    // Empty preview removes body display, and returns true on transition
    store.previews.set("s1", { text: "", bullets: [] })
    expect(updateSessionCard(card, store, "s1", NOW)).toBe(true)
    expect(card.body.classList.contains("empty")).toBe(true)

    // Pure timestamp advance while stopped/failed/done does NOT mark heightChanged
    s.outcome = "interrupted"
    updateSessionCard(card, store, "s1", NOW)
    expect(card.root.classList.contains("st-stopped")).toBe(true)
    expect(updateSessionCard(card, store, "s1", NOW + 120_000)).toBe(false)
  })
})
