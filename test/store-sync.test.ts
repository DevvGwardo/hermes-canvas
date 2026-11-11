import { describe, expect, it } from "bun:test"
import type { Backend } from "../src/app/backend"
import { ALLOW_ALL, REVIEW_WINDOW, Store } from "../src/app/store"
import type { Session } from "../src/app/types"

// The canvas list is only as accurate as two store paths: refreshRecent()
// reconciles the local session map with what the server (and the TUI) sees,
// and groups() decides what the user sees and in what order. Both run against
// a real Store; the backend fake only serves list snapshots.

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

function backendWith(initial: Session[], projects: Array<{ id: string; name?: string; canonical: string }> = [{ id: "p1", name: "hermes", canonical: "/home/t/a" }]) {
  let list = initial
  let fail = false
  let failProjects = false
  let failActive = false
  const backend = {
    listProjects: async () => {
      if (failProjects) throw new Error("server down")
      return projects
    },
    listSessions: async () => {
      if (fail) throw new Error("server down")
      return list
    },
    active: async () => {
      if (failActive) throw new Error("server down")
      return new Set<string>()
    },
  }
  return {
    backend: backend as unknown as Backend,
    setList: (s: Session[]) => {
      list = s
    },
    setFail: (f: boolean) => {
      fail = f
    },
    setFailProjects: (f: boolean) => {
      failProjects = f
    },
    setFailActive: (f: boolean) => {
      failActive = f
    },
  }
}

async function loadedStore(initial: Session[], projects?: Array<{ id: string; name?: string; canonical: string }>) {
  const b = backendWith(initial, projects)
  const store = new Store(b.backend)
  await store.reload()
  return { store, ...b }
}

const refresh = (store: Store) => store["refreshRecent"]() as Promise<void>

describe("Store — refreshRecent reconciliation", () => {
  it("pulls in new live sessions and never adds ones the server says are archived", async () => {
    const s1 = sess("s1")
    const s2 = sess("s2")
    const s3 = sess("s3", { time: { created: NOW - 9_000, updated: NOW - 4_000, archived: NOW - 1_000 } })
    const { store, setList } = await loadedStore([s1])
    setList([s1, s2, s3])
    await refresh(store)
    expect([...store.sessions.keys()].sort()).toEqual(["s1", "s2"]) // s3 was archived: skipped
  })

  it("drops sessions the server marked archived since the last load", async () => {
    const s1 = sess("s1")
    const s2 = sess("s2")
    const { store, setList } = await loadedStore([s1, s2])
    setList([{ ...s1, time: { ...s1.time, archived: NOW } }, s2])
    await refresh(store)
    expect([...store.sessions.keys()]).toEqual(["s2"])
  })

  it("replaces changed sessions but leaves untouched ones by reference", async () => {
    const s1 = sess("s1", { time: { created: NOW - 10_000, updated: NOW - 5_000, idle: NOW - 3_000, viewed: NOW - 2_500 } })
    const s2 = sess("s2")
    const { store, setList } = await loadedStore([s1, s2])
    const s1Fresh = { ...s1, time: { ...s1.time, idle: NOW - 1_000 } }
    setList([s1Fresh, s2]) // s2 identical
    await refresh(store)
    expect(store.sessions.get("s1")!.time.idle).toBe(NOW - 1_000)
    expect(store.sessions.get("s1")).not.toBe(s1) // replaced object
    expect(store.sessions.get("s2")).toBe(s2) // untouched: same reference
  })

  it("keeps whichever side has looked at the session more recently", async () => {
    const a = sess("a", { time: { created: NOW - 10_000, updated: NOW - 5_000, idle: NOW - 4_000, viewed: 900 } })
    const b = sess("b", { time: { created: NOW - 10_000, updated: NOW - 5_000, idle: NOW - 4_000, viewed: 100 } })
    const { store, setList } = await loadedStore([a, b])
    setList([
      { ...a, time: { ...a.time, viewed: 100 } }, // TUI hasn't seen what we have
      { ...b, time: { ...b.time, viewed: 900 } }, // TUI saw more than we did
    ])
    await refresh(store)
    expect(store.sessions.get("a")!.time.viewed).toBe(900) // local "seen" wins
    expect(store.sessions.get("b")!.time.viewed).toBe(900) // server "seen" wins
  })

  it("marks structure only when membership or titles change, not for viewed/idle churn", async () => {
    const s1 = sess("s1", { title: "old" })
    const { store, setList } = await loadedStore([s1])
    store["structureDirty"] = false
    setList([{ ...s1, time: { ...s1.time, idle: NOW } }]) // same title, new idle
    await refresh(store)
    expect(store["structureDirty"]).toBe(false)

    store["structureDirty"] = false
    setList([{ ...s1, title: "renamed in the TUI", time: { ...s1.time, idle: NOW } }])
    await refresh(store)
    expect(store["structureDirty"]).toBe(true)
  })

  it("rebuilds the parent→children map when a subagent session appears", async () => {
    const parent = sess("p1s")
    const { store, setList } = await loadedStore([parent])
    expect(store["children"].get("p1s")?.size ?? 0).toBe(0)
    setList([parent, sess("sub1", { parentID: "p1s" })])
    await refresh(store)
    expect([...store["children"].get("p1s")!]).toEqual(["sub1"])
  })

  it("swallows a failing refresh without touching the store", async () => {
    const s1 = sess("s1")
    const { store, setFail } = await loadedStore([s1])
    setFail(true)
    await refresh(store) // resolves, does not throw
    expect(store.sessions.get("s1")).toBe(s1)
  })
})

describe("Store — reload's best-effort fetches", () => {
  it("loads the sessions even when projects or active fail", async () => {
    const b = backendWith([sess("s1")])
    b.setFailProjects(true)
    b.setFailActive(true)
    const store = new Store(b.backend)
    await store.reload() // both side fetches degrade to empty; listSessions is the required one
    expect([...store.sessions.keys()]).toEqual(["s1"])
    expect(store.projects.size).toBe(0)
    expect(store.running.size).toBe(0)
  })
})

describe("Store — groups() ordering", () => {
  it("groups by project, labels from the project record, newest group first", async () => {
    const { store } = await loadedStore(
      [sess("a", { time: { created: 1, updated: 100 } }), sess("b", { projectID: "p2", location: { directory: "/home/t/dotfiles" }, time: { created: 2, updated: 200 } })],
      [
        { id: "p1", name: "hermes", canonical: "/home/t/a" },
        { id: "p2", canonical: "/home/t/dotfiles" }, // no name → folder basename
      ],
    )
    const g = store.groups()
    expect(g.map((x) => x.label)).toEqual(["dotfiles", "hermes"]) // b's project updated most recently
    expect(g[0]!.directory).toBe("/home/t/dotfiles") // the group's folder is its freshest session's
  })

  it("floats a project with a working session to the top", async () => {
    const { store } = await loadedStore(
      [
        sess("old", { projectID: "p1", time: { created: 1, updated: 100 } }),
        sess("newer", { projectID: "p2", time: { created: 2, updated: 200 } }),
      ],
      [
        { id: "p1", canonical: "/home/t/a" },
        { id: "p2", canonical: "/home/t/b" },
      ],
    )
    store.running.add("old")
    const g = store.groups()
    expect(g.map((x) => x.label)).toEqual(["a", "b"]) // working outranks recency
  })

  it("sorts within a project: needs-you, working, review, then done by recency", async () => {
    const { store } = await loadedStore([
      sess("done1", { time: { created: 1, updated: 100 } }),
      sess("review1", { time: { created: 2, updated: 200, idle: NOW - 1_000, viewed: NOW - 5_000 } }), // unseen + idle inside 48h
      sess("work1", { time: { created: 3, updated: 300 } }),
      sess("ask1", { time: { created: 4, updated: 50 } }), // oldest, but needs the user
      sess("done2", { time: { created: 5, updated: 400 } }),
    ])
    store.permissions.set("ask1", [{ id: "pr1", sessionID: "ask1", action: "bash.run", resources: [] }])
    store.running.add("work1")
    const g = store.groups()
    expect(g.length).toBe(1)
    expect(g[0]!.sessions.map((s) => s.id)).toEqual(["ask1", "work1", "review1", "done2", "done1"])
  })

  it("ranks an unseen failure with review and sinks a seen one", async () => {
    const { store } = await loadedStore([
      sess("fresh-fail", { outcome: "failed", time: { created: 1, updated: 100, idle: NOW - 1_000, viewed: NOW - 5_000 } }),
      sess("seen-fail", { outcome: "failed", time: { created: 2, updated: 200, idle: NOW - 5_000, viewed: NOW - 1_000 } }),
      sess("plain", { time: { created: 3, updated: 50 } }),
    ])
    const ids = store.groups()[0]!.sessions.map((s) => s.id)
    expect(ids).toEqual(["fresh-fail", "seen-fail", "plain"]) // unseen failure floats; looked-at failure is just done
  })

  it("keeps subagent sessions out of the list while their parent works", async () => {
    const { store } = await loadedStore([sess("p1s"), sess("sub1", { parentID: "p1s" })])
    store.running.add("sub1")
    expect(store.status("p1s")).toBe("working") // a running child makes the parent work
    const g = store.groups()
    expect(g.length).toBe(1)
    expect(g[0]!.sessions.map((s) => s.id)).toEqual(["p1s"]) // sub1 never gets its own row
  })

  it("ranks expired unseen failures alongside done so groups() agrees with statusCounts/inFilter", async () => {
    const expiredIdle = NOW - REVIEW_WINDOW - 5_000
    const { store } = await loadedStore([
      sess("expired-fail", { outcome: "failed", time: { created: 1, updated: 500, idle: expiredIdle } }),
      sess("recent-done", { outcome: "succeeded", time: { created: 2, updated: 900, idle: NOW - 1_000, viewed: NOW } }),
    ])
    expect(store.groups()[0]!.sessions.map((s) => s.id)).toEqual(["recent-done", "expired-fail"])
  })
})

describe("Store — D2 metadata preservation, reload cleanup & graph guards", () => {
  it("refreshRecent preserves undefined permissions and local failed/interrupted outcomes until idle changes", async () => {
    const fail = sess("s_fail", {
      outcome: "failed",
      permissions: [ALLOW_ALL],
      time: { created: 100, updated: 200, idle: 300, viewed: 400 },
    })
    const { store, setList } = await loadedStore([fail])
    store.previews.set("s_fail", { text: "old", bullets: [] })

    // Server returns same idle with outcome omitted or defaulted to "succeeded" + newer local viewed
    setList([
      sess("s_fail", {
        outcome: undefined,
        permissions: undefined,
        time: { created: 100, updated: 200, idle: 300, viewed: 100 },
      }),
    ])
    await refresh(store)
    expect(store.sessions.get("s_fail")).toBe(fail) // nothing effectively changed -> kept reference
    expect(store.sessions.get("s_fail")!.outcome).toBe("failed")
    expect(store.sessions.get("s_fail")!.permissions).toEqual([ALLOW_ALL])

    // Once idle advances (new turn finished), update outcome & mark preview stale
    setList([
      sess("s_fail", {
        outcome: "succeeded",
        permissions: [ALLOW_ALL],
        time: { created: 100, updated: 500, idle: 500, viewed: 100 },
      }),
    ])
    await refresh(store)
    expect(store.sessions.get("s_fail")!.outcome).toBe("succeeded")
    expect(store["previewStale"].has("s_fail")).toBe(true)
  })

  it("refreshRecent detects parentID/model/cost changes and reload prunes vanished sessions", async () => {
    const s1 = sess("s1", { model: { providerID: "p", id: "m1" }, cost: 1 })
    const s2 = sess("s2")
    const { store, setList } = await loadedStore([s1, s2])
    store.previews.set("s2", { text: "p", bullets: [] })
    store.permissions.set("s2", [{ id: "per", sessionID: "s2", action: "shell", resources: [] }])
    store.activity.set("s2", "Working…")

    // s1 changes cost/model/parentID
    store["structureDirty"] = false
    setList([
      sess("s1", { parentID: "s2", model: { providerID: "p", id: "m2" }, cost: 2 }),
      s2,
    ])
    await refresh(store)
    expect(store["structureDirty"]).toBe(true)
    expect(store.sessions.get("s1")!.cost).toBe(2)
    expect(store.sessions.get("s1")!.model?.id).toBe("m2")
    expect(store.subagentCount("s2")).toBe(1)

    // reload removes s2 when server no longer returns it (or archives it)
    setList([sess("s1")])
    await store.reload()
    expect(store.previews.has("s2")).toBe(false)
    expect(store.permissions.has("s2")).toBe(false)
    expect(store.activity.has("s2")).toBe(false)
  })

  it("addSessions skips archived entries and roots() breaks parent cycles cleanly", async () => {
    const { store } = await loadedStore([])
    store.addSessions([
      sess("self", { parentID: "self" }),
      sess("cyc_a", { parentID: "cyc_b" }),
      sess("cyc_b", { parentID: "cyc_a" }),
      sess("arch", { time: { created: 1, updated: 1, archived: 10 } }),
    ])
    expect(store.sessions.has("arch")).toBe(false)
    expect(store.subagentCount("self")).toBe(0)
    expect(store.roots().map((s) => s.id).sort()).toEqual(["cyc_a", "self"])
  })
})
