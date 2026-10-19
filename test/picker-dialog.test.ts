import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { Backend } from "../src/app/backend"
import { NewSessionPicker } from "../src/app/picker"
import { Store } from "../src/app/store"
import type { Session } from "../src/app/types"

// T30: the new-session picker DIALOG - open/close shell, where-mode project
// and folder lists, the typed-folder existence guard, choice + keyboard
// flow. The option builders themselves are covered by test/picker.test.ts
// (T25); this file drives them through the real DOM wiring. The model-mode
// list BUILDING is asserted in picker.test.ts (modelOptions describe, T26):
// those expectations derive from the shared models()/serverDefault()
// cache promises, so they hold whichever file warmed them. What stays out
// here is the dialog-level render of model rows plus the sort/def-absent
// branches, which need a cache-reset seam (T43, human call). Everything
// asserted here is cache-agnostic; choose()'s model branch is driven by
// injecting options.

class FakeEl {
  tag: string
  className = ""
  textContent = ""
  hidden = false
  title = ""
  type = ""
  value: any = ""
  placeholder = ""
  checked = false
  attrs: Record<string, string> = {}
  children: FakeEl[] = []
  parent: FakeEl | null = null
  handlers: Record<string, Array<(e: any) => void>> = {}
  private html = ""

  constructor(tag: string) {
    this.tag = tag
  }

  get innerHTML() {
    return this.html
  }

  set innerHTML(v: string) {
    this.html = v
    for (const c of this.children) c.parent = null
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

  fire(type: string, extra: Record<string, any> = {}) {
    const ev = { preventDefault() {}, stopPropagation() {}, target: this, ...extra }
    for (const fn of this.handlers[type] ?? []) fn(ev)
  }

  focus() {}
  blur() {}
  scrollIntoView() {}
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
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

let saved: Record<string, unknown> = {}
let ls = new Map<string, string>()

beforeEach(() => {
  for (const k of ["document", "requestAnimationFrame"]) saved[k] = (globalThis as any)[k]
  ;(globalThis as any).requestAnimationFrame = () => 0 // focus armed, never driven
  ;(globalThis as any).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => {
      const n = new FakeEl("#text")
      n.textContent = t
      return n
    },
  }
  ls = new Map()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
    setItem: (k: string, v: string) => void ls.set(k, String(v)),
    removeItem: (k: string) => void ls.delete(k),
  }
})

afterEach(() => {
  for (const k of Object.keys(saved)) (globalThis as any)[k] = saved[k]
})

const NOW = Date.now()
const mk = (id: string, directory: string, projectID: string, updated: number): Session =>
  ({
    id,
    projectID,
    cost: 0,
    tokens: {} as any,
    outcome: "succeeded",
    time: { created: NOW - 3_600_000, updated: NOW - updated, idle: NOW - updated, viewed: NOW },
    location: { directory },
  }) as unknown as Session

/** Two projects: alpha (2 sessions, fresher) and beta (1). Folders under home. */
const HOME = "/home/u"
const FOLDERS: Record<string, string[]> = {
  [HOME]: ["alpha", "beta", "code", ".config"],
  "/home/u/code": ["app", "lib"],
  "/home/u/code/app": [],
  "/home/u/code/lib": [],
  "/home/u/alpha": [],
  "/home/u/beta": [],
}

async function pickerFixture() {
  const sessions = [mk("s1", `${HOME}/alpha`, "p1", 1_000), mk("s2", `${HOME}/alpha`, "p1", 60_000), mk("s3", `${HOME}/beta`, "p3", 120_000)]
  const backend = {
    listProjects: async () => [],
    listSessions: async () => sessions,
    active: async () => new Set<string>(),
    listFolders: async (dir: string) => FOLDERS[dir] ?? [],
    listModels: async () => [],
    serverDefaultModel: async () => undefined,
  } as unknown as Backend
  const store = new Store(backend)
  await store.reload()
  const host = new FakeEl("div")
  const picks: Array<{ directory: string; model: any; auto: boolean }> = []
  const picker = new NewSessionPicker(host as any, store, backend, HOME, async (directory, model, autoApprove) => {
    picks.push({ directory, model, auto: autoApprove })
  })
  const scrim = () => host.children[0]
  const input = () => picker["input"] as unknown as FakeEl
  const list = () => picker["list"] as unknown as FakeEl
  const foot = () => picker["foot"] as unknown as FakeEl
  const modelBtn = () => picker["modelBtn"] as unknown as FakeEl
  const autoBox = () => picker["autoBox"] as unknown as FakeEl
  const rows = () => list().children.filter((c) => c.className.includes("picker-item"))
  const type = async (q: string) => {
    input().value = q
    input().fire("input")
    await flush()
  }
  const key = async (k: string, extra: Record<string, any> = {}) => {
    input().fire("keydown", { key: k, shiftKey: false, ...extra })
    await flush()
  }
  return { picker, store, host, picks, scrim, input, list, foot, modelBtn, autoBox, rows, type, key }
}

describe("picker dialog — shell", () => {
  it("open builds the dialog once; a second open just refocuses", async () => {
    const { picker, host, scrim, input, autoBox } = await pickerFixture()
    expect(picker.isOpen).toBe(false)
    picker.open()
    await flush()
    expect(picker.isOpen).toBe(true)
    const box = scrim().children[0]!
    expect(box.attrs["role"]).toBe("dialog")
    expect(box.attrs["aria-label"]).toBe("New session")
    expect(input().className).toBe("picker-input")
    expect(autoBox().checked).toBe(false) // store.autoApproveAll off

    const el = picker["el"]
    picker.open(`${HOME}/beta`) // already open -> focus, no rebuild
    expect(picker["el"]).toBe(el)
  })

  it("close removes the scrim and flips isOpen", async () => {
    const { picker, host } = await pickerFixture()
    picker.open()
    await flush()
    expect(host.children.length).toBe(1)
    picker.close()
    expect(picker.isOpen).toBe(false)
    expect(host.children.length).toBe(0)
  })
})

describe("picker dialog — where mode, projects", () => {
  it("lists store projects with counts, icon and the first row active", async () => {
    const { picker, rows, list, modelBtn } = await pickerFixture()
    picker.open()
    await flush()
    expect(list().attrs["role"]).toBe("listbox")
    const rs = rows()
    expect(rs.length).toBe(2) // alpha + beta
    const labels = rs.map((r) => find(r, (e) => e.className.includes("picker-label"))!.textContent)
    expect(labels).toContain("alpha")
    expect(labels).toContain("beta")
    const alpha = rs.find((r) => textOf(r).includes("alpha"))!
    expect(textOf(alpha)).toContain("2 sessions") // pluralisation
    expect(find(alpha, (e) => e.className.includes("picker-icon"))!.textContent).toBe("◆")
    expect(alpha.className).toContain("picker-item project active")
    expect(alpha.attrs["aria-selected"]).toBe("true")
    expect(find(modelBtn(), (e) => e.className.includes("pm-k"))!.textContent).toBe("Model")
    expect(find(modelBtn(), (e) => e.className.includes("pm-caret"))!.textContent).toBe("▾")
  })

  it("typing filters projects; an unknown query shows the typed-path hint", async () => {
    const { picker, rows, list, type } = await pickerFixture()
    picker.open()
    await flush()
    await type("beta")
    expect(rows().length).toBe(1)
    expect(textOf(rows()[0]!)).toContain("beta")

    await type("zzz")
    expect(rows().length).toBe(0)
    const empty = find(list(), (e) => e.className.includes("picker-empty"))!
    expect(empty.textContent).toContain("No matching projects. Type a path like ~/code/app to start somewhere new.")
  })

  it("the preferred directory floats to the top when the query is empty", async () => {
    const { picker, rows, type } = await pickerFixture()
    picker.open(`${HOME}/beta`) // alpha is fresher, so beta would be second
    await flush()
    expect(textOf(rows()[0]!)).toContain("beta")
    expect(rows()[0]!.className).toContain("active")

    await type("al") // a query disables the float (only alpha matches anyway)
    expect(rows().length).toBe(1)
    await type("") // clearing re-applies the float
    expect(textOf(rows()[0]!)).toContain("beta")
  })
})

describe("picker dialog — where mode, folder autocomplete", () => {
  it("a partial path lists matching folders with the not-yet option last", async () => {
    const { picker, rows, type } = await pickerFixture()
    picker.open()
    await flush()
    await type("~/co")
    const rs = rows()
    expect(rs.length).toBe(2)
    expect(rs[0]!.className).toContain("folder")
    expect(find(rs[0]!, (e) => e.className.includes("picker-label"))!.textContent).toBe("code")
    expect(textOf(rs[0]!)).toContain("~/code") // home shortened
    expect(rs[1]!.className).toContain("path")
    expect(textOf(rs[1]!)).toContain("Start in ~/co")
    expect(textOf(rs[1]!)).toContain("No folder here yet. Pick one below or keep typing")
  })

  it("a trailing slash lists the children with Start-in first", async () => {
    const { picker, rows, type } = await pickerFixture()
    picker.open()
    await flush()
    await type("~/code/")
    const rs = rows()
    expect(rs.length).toBe(3)
    expect(rs[0]!.className).toContain("path")
    expect(textOf(rs[0]!)).toContain("New session in this folder")
    expect(rs.slice(1).map((r) => find(r, (e) => e.className.includes("picker-label"))!.textContent)).toEqual(["app", "lib"])
  })

  it("hidden folders only show once the leaf itself starts with a dot", async () => {
    const { picker, rows, type } = await pickerFixture()
    picker.open()
    await flush()
    await type("~/co")
    expect(textOf(rows()[0]!)).not.toContain(".config")
    await type("~/.c")
    expect(rows().map((r) => find(r, (e) => e.className.includes("picker-label"))!.textContent)).toContain(".config")
  })

  it("Tab (and clicking a folder row) completes into the folder and lists inside", async () => {
    const { picker, rows, input, type, key } = await pickerFixture()
    picker.open()
    await flush()
    await type("~/co")
    await key("Tab") // into the highlighted folder
    expect(input().value).toBe("~/code/")
    const rs = rows()
    expect(rs.length).toBe(3) // Start-in + app + lib

    await type("~/code/") // clicking a child folder drills in the same way
    rows()[1]!.fire("click") // "app"
    expect(input().value).toBe("~/code/app/")
  })

  it("double-clicking a folder row chooses it instead of completing into it", async () => {
    const { picker, rows, picks, input, type } = await pickerFixture()
    picker.open()
    await flush()
    await type("~/co")
    rows()[0]!.fire("dblclick") // folder "code": dblclick starts the session there
    await flush()
    expect(picker.isOpen).toBe(false)
    expect(picks).toEqual([{ directory: `${HOME}/code`, model: undefined, auto: false }])
    expect(input().value).not.toBe("~/code/") // did NOT complete into it
  })
})

describe("picker dialog — choosing", () => {
  it("Enter on a project starts the session with the remembered model and auto-approve state", async () => {
    ls.set("occ.model", "old/prov") // the canvas remembers the last model
    const { picker, store, picks, rows, autoBox, key } = await pickerFixture()
    store.autoApproveAll = true
    picker.open()
    await flush()
    expect(autoBox().checked).toBe(true) // seeded from the store
    expect(textOf(rows()[0]!)).toContain("alpha")

    await key("Enter")
    expect(picker.isOpen).toBe(false)
    expect(picks).toEqual([{ directory: `${HOME}/alpha`, model: { providerID: "old", id: "prov" }, auto: true }])
  })

  it("a folder option whose parent no longer lists it errors without starting", async () => {
    const { picker, list, picks, key } = await pickerFixture()
    picker.open()
    await flush()
    // stale autocomplete row (e.g. deleted on disk since the list was built)
    picker["options"] = [{ kind: "folder", label: "ghost", sub: "", directory: `${HOME}/ghost` }]
    picker["active"] = 0
    await key("Enter")
    expect(picker.isOpen).toBe(true) // still choosing
    expect(picks).toEqual([])
    expect(list().children.length).toBe(1)
    expect(list().children[0]!.className).toContain("picker-empty error")
    expect(textOf(list().children[0]!)).toContain(`${HOME}/ghost doesn't exist (or isn't a folder).`)
  })

  it("model choices: server-default clears the remembered model, a model sets and persists it", async () => {
    ls.set("occ.model", "old/prov")
    const { picker, modelBtn, key } = await pickerFixture()
    picker.open()
    await flush()

    // server-default branch (options injected; the list itself is cache-dependent)
    picker["mode"] = "model"
    picker["options"] = [{ kind: "server-default", label: "Hermes default", sub: "" }]
    picker["active"] = 0
    await key("Enter")
    expect(picker["model"]).toBeUndefined()
    expect(ls.has("occ.model")).toBe(false) // setDefaultModel(undefined) cleared it
    expect(picker["mode"] as string).toBe("where") // back to the directory step

    // a concrete model persists and lands on the button
    picker["mode"] = "model"
    picker["options"] = [{ kind: "model", label: "Test Model", sub: "prov/m1", model: { id: "m1", providerID: "prov" } }]
    picker["active"] = 0
    await key("Enter")
    expect(picker["model"]).toEqual({ id: "m1", providerID: "prov" })
    expect(ls.get("occ.model")).toBe("prov/m1")
    expect(picker["mode"] as string).toBe("where")
    await flush() // renderModelButton settles on the injected ref
    expect(find(modelBtn(), (e) => e.className.includes("pm-v"))!.textContent).toBe("m1") // fallback: the ref itself
    expect(find(modelBtn(), (e) => e.className.includes("pm-s"))!.textContent).toBe("prov")
  })
})

describe("picker dialog — keyboard", () => {
  it("arrows move the active row and wrap around", async () => {
    const { picker, rows, key } = await pickerFixture()
    picker.open()
    await flush()
    await key("ArrowDown")
    expect(rows()[1]!.attrs["aria-selected"]).toBe("true")
    expect(rows()[0]!.attrs["aria-selected"]).toBe("false")
    await key("ArrowUp")
    await key("ArrowUp") // wraps past the top
    expect(rows()[1]!.attrs["aria-selected"]).toBe("true")
  })

  it("Escape closes from the directory step", async () => {
    const { picker, key } = await pickerFixture()
    picker.open()
    await flush()
    await key("Escape")
    expect(picker.isOpen).toBe(false)
  })

  it("Shift+Tab toggles the model step and back, saving and restoring the typed query", async () => {
    const { picker, input, foot, key } = await pickerFixture()
    picker.open()
    await flush()
    expect(foot().innerHTML).toContain("into folder")
    expect(input().placeholder).toContain("Search projects")

    input().value = "alpha" // stashed by setMode when it flips to the model step
    await key("Tab", { shiftKey: true })
    expect(picker["mode"]).toBe("model")
    expect(input().value).toBe("") // where query stashed
    expect(input().placeholder).toContain("Search models")
    expect(input().attrs["aria-label"]).toBe("Model")
    expect(foot().innerHTML).toContain("use model")

    await key("Escape") // model step -> back, not close
    expect(picker.isOpen).toBe(true)
    expect(picker["mode"]).toBe("where")
    expect(input().value).toBe("alpha") // stashed query restored
    expect(input().attrs["aria-label"]).toBe("Project or folder")
  })
})

