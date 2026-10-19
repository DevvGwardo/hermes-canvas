import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import type { Backend } from "../src/app/backend"
import { NewSessionPicker } from "../src/app/picker"
import { Store } from "../src/app/store"
import type { Session } from "../src/app/types"

// The picker's DOM lives in open(), which these tests never call: the option
// builders (project search, folder autocomplete, model list) and choose()'s
// filesystem safety check are pure logic over the store + backend, driven
// through bracket access the way the input events would drive them.

const sess = (id: string, projectID: string, directory: string, updated: number): Session =>
  ({
    id,
    projectID,
    cost: 0,
    tokens: {} as any,
    outcome: "succeeded",
    time: { created: updated - 10, updated, viewed: updated },
    title: id,
    location: { directory },
  }) as unknown as Session

function pickerBackend(opts: {
  projects?: Array<{ id: string; name?: string; canonical: string }>
  sessions?: Session[]
  folders?: Record<string, string[]>
} = {}) {
  const folderCalls: string[] = []
  const backend = {
    listProjects: async () => opts.projects ?? [],
    listSessions: async () => opts.sessions ?? [],
    active: async () => new Set<string>(),
    listFolders: async (dir: string) => {
      folderCalls.push(dir)
      return opts.folders?.[dir] ?? []
    },
  }
  return { backend: backend as unknown as Backend, folderCalls }
}

function newPicker(backend: Backend, store: Store, home = "/home/t") {
  const onPick = jest.fn(async () => {})
  const p = new NewSessionPicker({} as any, store, backend, home, onPick)
  return { p, onPick }
}

describe("NewSessionPicker — projectOptions (where mode)", () => {
  const projects = [
    { id: "p1", name: "hermes-canvas", canonical: "/home/t/hermes-canvas" },
    { id: "p2", name: "dotfiles", canonical: "/home/t/dotfiles" },
  ]
  const sessions = [
    sess("s1", "p1", "/home/t/hermes-canvas", 300),
    sess("s2", "p1", "/home/t/hermes-canvas", 100),
    sess("s3", "p2", "/home/t/dotfiles", 200),
  ]

  async function loadedPicker() {
    const { backend } = pickerBackend({ projects, sessions })
    const store = new Store(backend)
    await store.reload()
    const { p, onPick } = newPicker(backend, store)
    return { p, onPick, opts: (q: string) => p["projectOptions"](q) as any[] }
  }

  it("AND-matches terms across label and the FULL directory path, case-insensitively", async () => {
    const { opts } = await loadedPicker()
    expect(opts("canvas").map((o) => o.label)).toEqual(["hermes-canvas"])
    expect(opts("HERMES canvas").map((o) => o.label)).toEqual(["hermes-canvas"]) // two terms, one option
    expect(opts("t/dot").map((o) => o.label)).toEqual(["dotfiles"]) // matches on the raw path, not the ~ display
    expect(opts("canvas dotfiles")).toEqual([]) // AND, not OR
  })

  it("one option per project: sessions in the same folder merge into one row", async () => {
    const { opts } = await loadedPicker()
    const [a, b] = opts("")
    expect(a.label).toBe("hermes-canvas")
    expect(a.directory).toBe("/home/t/hermes-canvas") // the freshest session's folder wins
    expect(a.sub).toContain("~/hermes-canvas") // home shortened for display only
    expect(a.sub).toContain("2 sessions")
    expect(b.label).toBe("dotfiles")
    expect(b.sub).toContain("1 session") // singular
    expect(b.sub).not.toContain("sessions")
    expect(opts("").map((o) => o.directory)).toEqual(["/home/t/hermes-canvas", "/home/t/dotfiles"]) // groups() order: newest first
  })

  it("pins the preferred directory to the top only while the query is empty", async () => {
    const { p, opts } = await loadedPicker()
    p["preferred"] = "/home/t/dotfiles"
    expect(opts("").map((o) => o.label)).toEqual(["dotfiles", "hermes-canvas"]) // moved to front
    expect(opts("canvas").map((o) => o.label)).toEqual(["hermes-canvas"]) // query active: no pinning
  })

  it("dedupes two projects that share a directory", async () => {
    const { backend } = pickerBackend({
      projects: [
        { id: "p1", name: "one", canonical: "/home/t/shared" },
        { id: "p2", name: "two", canonical: "/home/t/shared" },
      ],
      sessions: [sess("s1", "p1", "/home/t/shared", 300), sess("s2", "p2", "/home/t/shared", 200)],
    })
    const store = new Store(backend)
    await store.reload()
    const { p } = newPicker(backend, store)
    const opts = p["projectOptions"]("") as any[]
    expect(opts.length).toBe(1)
    expect(opts[0]!.directory).toBe("/home/t/shared")
  })

  it("caps the list at 60 entries", async () => {
    const many = Array.from({ length: 70 }, (_, i) => sess(`s${i}`, `p${i}`, `/home/t/p${i}`, 1000 - i))
    const { backend } = pickerBackend({
      projects: many.map((s) => ({ id: s.projectID, name: undefined as string | undefined, canonical: s.location.directory })),
      sessions: many,
    })
    const store = new Store(backend)
    await store.reload()
    const { p } = newPicker(backend, store)
    expect((p["projectOptions"]("") as any[]).length).toBe(60)
  })
})

describe("NewSessionPicker — folderOptions (path mode)", () => {
  const folders = {
    "/home/t": ["code", "work", ".config", "notes"],
    "/home/t/code": ["app", "app2", "archive"],
    "/": ["opt"],
  }

  async function pickerWithFolders() {
    const { backend, folderCalls } = pickerBackend({ folders })
    const store = new Store(backend)
    const { p } = newPicker(backend, store)
    return { p, folderCalls, opts: (raw: string, seq = 0) => p["folderOptions"](raw, seq) as Promise<any[] | undefined> }
  }

  it("offers prefix matches and keeps the typed path as a last-resort option", async () => {
    const { opts } = await pickerWithFolders()
    const o = (await opts("~/co"))!
    expect(o.map((x) => x.kind)).toEqual(["folder", "path"]) // matches first, "start here" last when it doesn't exist
    expect(o[0]!.directory).toBe("/home/t/code")
    expect(o.at(-1)!.directory).toBe("/home/t/co")
    expect(o.at(-1)!.sub).toContain("No folder here yet")
    expect(o.map((x) => x.label)).not.toContain(".config") // dot-dirs hidden unless the leaf starts with a dot
  })

  it("shows the typed folder first when it exists", async () => {
    const { opts } = await pickerWithFolders()
    const o = (await opts("~/code"))!
    expect(o.length).toBe(1) // exact leaf is excluded from the match list
    expect(o[0]!.kind).toBe("path")
    expect(o[0]!.sub).toContain("New session in this folder")
  })

  it("lists a trailing-slash folder's children with the start option first", async () => {
    const { opts } = await pickerWithFolders()
    const o = (await opts("~/code/"))!
    expect(o[0]!.kind).toBe("path")
    expect(o[0]!.sub).toContain("New session in this folder")
    expect(o.slice(1).map((x) => x.label)).toEqual(["app", "app2", "archive"])
    expect(o[1]!.directory).toBe("/home/t/code/app")
  })

  it("reveals dot-directories once the leaf starts with a dot", async () => {
    const { opts } = await pickerWithFolders()
    const o = (await opts("~/."))!
    expect(o.map((x) => x.label)).toContain(".config")
  })

  it("joins paths correctly from the filesystem root", async () => {
    const { opts } = await pickerWithFolders()
    const o = (await opts("/op"))!
    expect(o[0]!.directory).toBe("/opt") // base "/" must not double-slash
  })

  it("drops results whose sequence went stale while the backend was listing", async () => {
    const { p, opts } = await pickerWithFolders()
    p["seq"] = 3
    expect(await opts("~/co", 2)).toBeUndefined() // an older keystroke's answer
    expect((await opts("~/co", 3))!.length).toBeGreaterThan(0) // current keystroke proceeds
  })

  it("caches folder listings per directory", async () => {
    const { folderCalls, opts } = await pickerWithFolders()
    await opts("~/co")
    await opts("~/cod") // same parent
    await opts("~/code/") // exact dir listed too
    expect(folderCalls.filter((d) => d === "/home/t")).toHaveLength(1) // one fetch per directory
  })
})

describe("NewSessionPicker — choose() safety", () => {
  let savedDoc: unknown
  beforeEach(() => {
    savedDoc = (globalThis as any).document
    ;(globalThis as any).document = {
      createElement: () => ({ className: "", textContent: "", children: [] as any[], replaceChildren(...n: any[]) {
        this.children = n
      } }),
    }
  })
  afterEach(() => {
    ;(globalThis as any).document = savedDoc
  })

  async function pickerWithFolders(folders: Record<string, string[]>) {
    const { backend, folderCalls } = pickerBackend({ folders })
    const store = new Store(backend)
    const { p, onPick } = newPicker(backend, store)
    p["autoBox"] = { checked: true } as any
    const list = { children: [] as any[], replaceChildren(...n: any[]) {
      this.children = n
    } }
    p["list"] = list as any
    return { p, onPick, folderCalls, list }
  }

  it("refuses a folder that does not exist instead of creating the session there", async () => {
    const { p, onPick, list } = await pickerWithFolders({ "/home/t": ["code"] })
    p["options"] = [{ kind: "folder", label: "ghost", sub: "", directory: "/home/t/ghost" }] as any
    p["active"] = 0
    await p["choose"]()
    expect(onPick).not.toHaveBeenCalled()
    expect(list.children[0]!.className).toContain("error")
    expect(list.children[0]!.textContent).toContain("doesn't exist")
  })

  it("passes an existing folder to onPick with the auto-approve flag", async () => {
    const { p, onPick } = await pickerWithFolders({ "/home/t": ["code"] })
    p["options"] = [{ kind: "folder", label: "code", sub: "", directory: "/home/t/code" }] as any
    p["active"] = 0
    await p["choose"]()
    expect(onPick).toHaveBeenCalledWith("/home/t/code", undefined, true)
  })

  it("skips the filesystem check for project options and for the root", async () => {
    const { p, onPick, folderCalls } = await pickerWithFolders({})
    p["options"] = [
      { kind: "project", label: "hermes-canvas", sub: "", directory: "/anywhere" },
      { kind: "folder", label: "/", sub: "", directory: "/" },
    ] as any
    p["active"] = 0
    await p["choose"]()
    p["active"] = 1
    await p["choose"]()
    expect(folderCalls).toEqual([]) // no verification listing for either
    expect(onPick).toHaveBeenCalledTimes(2)
    expect(onPick).toHaveBeenNthCalledWith(1, "/anywhere", undefined, true)
    expect(onPick).toHaveBeenNthCalledWith(2, "/", undefined, true)
  })
})
