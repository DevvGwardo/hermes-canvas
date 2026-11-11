import { afterEach, describe, expect, it, jest } from "bun:test"
import type { Backend } from "../src/app/backend"
import { ALLOW_ALL, Store } from "../src/app/store"
import type { FormInfo, PermissionRequest, Session } from "../src/app/types"

// The two pollers that keep "working" and "needs you" honest against server
// truth: syncActive reconciles the running set (15s), syncAsks reconciles a
// session's pending permission/question prompts and auto-approves the ones
// the rules allow. Both bracket-driven; the fake backend serves snapshots.

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

const req = (id: string, sessionID = "s1"): PermissionRequest => ({ id, sessionID, action: "bash.run", resources: ["*"] })
const form = (id: string, sessionID = "s1"): FormInfo => ({ id, sessionID, title: "Pick", fields: [] })

function backendWith(sessions: Session[] = [sess("s1")]) {
  let activeSet = new Set<string>()
  let failActive = false
  let perms: PermissionRequest[] = []
  let forms: FormInfo[] = []
  let failPerms = false
  let failReply = new Set<string>()
  const replies: Array<{ sessionID: string; requestID: string; decision: string }> = []
  const backend = {
    listProjects: async () => [],
    listSessions: async () => sessions,
    active: async () => {
      if (failActive) throw new Error("down")
      return activeSet
    },
    permissions: async () => {
      if (failPerms) throw new Error("down")
      return perms
    },
    forms: async () => forms,
    replyPermission: async (sessionID: string, requestID: string, decision: string) => {
      if (failReply.has(requestID)) throw new Error("reply down")
      replies.push({ sessionID, requestID, decision })
    },
  }
  return {
    backend: backend as unknown as Backend,
    replies,
    setActive: (ids: string[]) => {
      activeSet = new Set(ids)
    },
    setFailActive: (f: boolean) => {
      failActive = f
    },
    setPerms: (p: PermissionRequest[]) => {
      perms = p
    },
    setForms: (f: FormInfo[]) => {
      forms = f
    },
    setFailPerms: (f: boolean) => {
      failPerms = f
    },
    setFailReply: (ids: string[]) => {
      failReply = new Set(ids)
    },
  }
}

async function loadedStore(sessions: Session[] = [sess("s1")]) {
  const b = backendWith(sessions)
  const store = new Store(b.backend)
  await store.reload()
  return { store, ...b }
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
const syncActive = (store: Store) => store["syncActive"]() as Promise<void>
const syncAsks = (store: Store, id: string) => store["syncAsks"](id) as Promise<void>

describe("Store — syncActive running-set reconcile", () => {
  it("joins and leaves the server's active set, touching only changed cards", async () => {
    const { store, setActive } = await loadedStore()
    store["activity"].set("a", "Reading")
    store["activity"].set("b", "Fetching")
    store["dirtyCards"].clear()
    setActive(["a", "b"])
    await syncActive(store)
    expect([...store.running].sort()).toEqual(["a", "b"])
    expect([...store["dirtyCards"]].sort()).toEqual(["a", "b"])

    store["dirtyCards"].clear()
    setActive(["b"]) // a finished
    await syncActive(store)
    expect([...store.running]).toEqual(["b"]) // a left the set
    expect(store["activity"].has("a")).toBe(false) // its activity label is cleaned up
    expect(store["activity"].get("b")).toBe("Fetching") // still-active label kept
    expect([...store["dirtyCards"]]).toEqual(["a"]) // only the changed card refreshes
  })

  it("leaves the running set identity alone when nothing changed", async () => {
    const { store, setActive } = await loadedStore()
    setActive(["a"])
    await syncActive(store)
    const ref = store.running
    await syncActive(store) // same set again
    expect(store.running).toBe(ref) // early return before the replace
  })

  it("lets server truth override local running guesses", async () => {
    const { store, setActive } = await loadedStore()
    store.running.add("ghost") // as an execution.started event might have
    setActive([])
    await syncActive(store)
    expect(store.running.has("ghost")).toBe(false) // the 15s reconcile clobbers it
  })

  it("swallows a failed poll without touching the running set", async () => {
    const { store, setActive, setFailActive } = await loadedStore()
    setActive(["a"])
    await syncActive(store)
    setFailActive(true)
    await syncActive(store) // resolves, does not throw
    expect([...store.running]).toEqual(["a"])
  })
})

describe("Store — syncAsks prompt reconcile", () => {
  it("pulls pending permissions and forms into the maps", async () => {
    const { store, setPerms, setForms } = await loadedStore()
    setPerms([req("p1")])
    setForms([form("f1")])
    await syncAsks(store, "s1")
    expect(store.permissions.get("s1")!.map((p) => p.id)).toEqual(["p1"])
    expect(store.forms.get("s1")!.map((f) => f.id)).toEqual(["f1"])
    expect(store.needsInput("s1")).toBe("permission")
    expect(store["dirtyCards"].has("s1")).toBe(true)
  })

  it("clears prompts that were answered elsewhere", async () => {
    const { store, setPerms, setForms } = await loadedStore()
    setPerms([req("p1")])
    setForms([form("f1")])
    await syncAsks(store, "s1")
    setPerms([])
    setForms([]) // the TUI answered them
    await syncAsks(store, "s1")
    expect(store.permissions.has("s1")).toBe(false) // empty lists delete the entry
    expect(store.forms.has("s1")).toBe(false)
    expect(store.needsInput("s1")).toBeUndefined()
  })

  it("a failing permissions fetch clears only that side", async () => {
    const { store, setForms, setFailPerms } = await loadedStore()
    setFailPerms(true)
    setForms([form("f1")])
    await syncAsks(store, "s1") // each side catches separately
    expect(store.permissions.has("s1")).toBe(false)
    expect(store.forms.get("s1")!.map((f) => f.id)).toEqual(["f1"])
  })

  it("auto-approves synced asks under an allow-all session", async () => {
    const { store, setPerms, replies } = await loadedStore([sess("s1", { permissions: [ALLOW_ALL] })])
    const onAutoApproved = jest.fn()
    store.onAutoApproved = onAutoApproved
    const p = req("p1")
    setPerms([p])
    await syncAsks(store, "s1")
    await flush() // the approve is fire-and-forget inside maybeAutoApprove
    expect(replies).toEqual([{ sessionID: "s1", requestID: "p1", decision: "once" }])
    expect(store.permissions.has("s1")).toBe(false) // the approved prompt is gone locally
    expect(onAutoApproved).toHaveBeenCalledWith(p)
  })

  it("the global auto-approve switch covers sessions without their own rule", async () => {
    const { store, setPerms, replies } = await loadedStore()
    store.autoApproveAll = true
    setPerms([req("p2")])
    await syncAsks(store, "s1")
    await flush()
    expect(replies.map((r) => r.requestID)).toEqual(["p2"])
  })

  it("a parent's allow-all rule covers its subagent's asks", async () => {
    const { store, setPerms, replies } = await loadedStore([sess("p1s", { permissions: [ALLOW_ALL] }), sess("sub1", { parentID: "p1s" })])
    setPerms([req("p3", "sub1")])
    await syncAsks(store, "sub1")
    await flush()
    expect(replies.map((r) => r.requestID)).toEqual(["p3"])
  })

  it("a failing auto-approve keeps its prompt pending and never wedges the guard", async () => {
    const { store, setPerms, replies, setFailReply } = await loadedStore([sess("s1", { permissions: [ALLOW_ALL] })])
    const onAutoApproved = jest.fn()
    store.onAutoApproved = onAutoApproved
    setPerms([req("p1"), req("p2")])
    setFailReply(["p2"]) // the server rejects just this one reply
    await syncAsks(store, "s1")
    await flush() // both approves are fire-and-forget; p2's rejection is swallowed
    expect(replies.map((r) => r.requestID)).toEqual(["p1"]) // p1 went through
    expect(store.permissions.get("s1")!.map((p) => p.id)).toEqual(["p2"]) // only the failed one is still pending
    expect(onAutoApproved).toHaveBeenCalledTimes(1) // the notice fires only after a real reply
    expect(onAutoApproved).toHaveBeenCalledWith(req("p1"))

    setFailReply([]) // the server comes back
    setPerms([req("p2")]) // p1 was answered; the server now reports only p2
    await syncAsks(store, "s1")
    await flush()
  expect(replies.map((r) => r.requestID)).toEqual(["p1", "p2"]) // the finally cleanup let the retry through
    expect(store.permissions.has("s1")).toBe(false)
    expect(onAutoApproved).toHaveBeenCalledTimes(2)
  })
})

describe("Store — sync races, touchParent, approve dedupe, autoApprove sync & stop()", () => {
  const g = globalThis as Record<string, unknown>
  const origStorage = g.localStorage

  afterEach(() => {
    jest.useRealTimers()
    if (origStorage === undefined) delete g.localStorage
    else g.localStorage = origStorage
  })

  it("touches parent cards when subagent asks or active state change", async () => {
    const { store, setActive, setPerms } = await loadedStore([
      sess("p1s"),
      sess("sub1", { parentID: "p1s" }),
    ])
    store["dirtyCards"].clear()
    setActive(["sub1"])
    await syncActive(store)
    expect(store["dirtyCards"].has("sub1")).toBe(true)
    expect(store["dirtyCards"].has("p1s")).toBe(true)

    store["dirtyCards"].clear()
    setPerms([req("per1", "sub1")])
    await syncAsks(store, "sub1")
    expect(store["dirtyCards"].has("sub1")).toBe(true)
    expect(store["dirtyCards"].has("p1s")).toBe(true)
  })

  it("ignores stale syncActive and syncAsks snapshots when live events arrive mid-fetch", async () => {
    let resolveActive!: (v: Set<string>) => void
    let resolvePerms!: (v: PermissionRequest[]) => void
    const b = {
      kind: "live" as const,
      listProjects: async () => [],
      listSessions: async () => [sess("s1")],
      active: () => new Promise<Set<string>>((r) => (resolveActive = r)),
      permissions: () => new Promise<PermissionRequest[]>((r) => (resolvePerms = r)),
      forms: async () => [],
    } as unknown as Backend
    const store = new Store(b)
    await (async () => {
      const p = store.reload()
      resolveActive(new Set())
      await p
    })()

    const activePoll = syncActive(store)
    ;(store as any).onEvent({ id: "e1", type: "session.execution.started", data: { sessionID: "s1" } })
    resolveActive(new Set()) // stale snapshot says s1 not running
    await activePoll
    expect(store.running.has("s1")).toBe(true)

    const askPoll = syncAsks(store, "s1")
    ;(store as any).onEvent({ id: "e2", type: "permission.asked", data: req("live1", "s1") })
    resolvePerms([]) // stale snapshot says no asks
    await askPoll
    expect(store.permissions.get("s1")?.map((p) => p.id)).toEqual(["live1"])
  })

  it("syncActive clears liveText when a session drops and approve() dedupes return values", async () => {
    const replies: string[] = []
    let releaseReply!: () => void
    const b = {
      kind: "live" as const,
      listProjects: async () => [],
      listSessions: async () => [sess("p1s"), sess("sub1", { parentID: "p1s" })],
      active: async () => new Set<string>(),
      permissions: async () => [],
      forms: async () => [],
      setSessionPermissions: async () => {},
      replyPermission: async (_sid: string, rid: string) => {
        replies.push(rid)
        if (rid === "per1") await new Promise<void>((r) => (releaseReply = r))
      },
    } as unknown as Backend
    const store = new Store(b)
    await store.reload()

    store.running.add("p1s")
    store.liveText.set("p1s", "partial stream")
    await syncActive(store)
    expect(store.liveText.has("p1s")).toBe(false)

    // In-flight approve returns false for duplicate call so approveAllPending does not overcount
    store.permissions.set("p1s", [req("per1", "p1s"), req("per2", "p1s")])
    const first = store.approve(req("per1", "p1s"))
    const batch = await store.approveAllPending()
    expect(batch).toBe(1) // only per2 went through via batch; per1 was already in flight
    releaseReply()
    expect(await first).toBe(true)
    expect(await store.approve(req("x", "p1s"))).toBe(true)

    // setSessionAutoApprove approves pre-existing subagent requests too and handles replaced Session object
    store.permissions.set("sub1", [req("sub_per", "sub1")])
    store.setSessionAutoApprove("p1s", true)
    store.sessions.set("p1s", sess("p1s")) // simulate concurrent refresh replacement while await in flight
    await flush()
    expect(replies).toContain("sub_per")
    expect(store.sessions.get("p1s")!.permissions).toEqual([ALLOW_ALL])
  })

  it("syncs autoApproveAll from localStorage to backend on start/reload/toggle and stop() cancels pending timers", async () => {
    jest.useFakeTimers()
    const storage: Record<string, string> = { "hermes-canvas.autoApprove": "1" }
    g.localStorage = {
      getItem: (k: string) => (k in storage ? storage[k]! : null),
      setItem: (k: string, v: string) => {
        storage[k] = v
      },
      removeItem: (k: string) => delete storage[k],
    }

    const autoCalls: boolean[] = []
    let activeCount = 0
    let recentCount = 0
    let unsubCount = 0
    let resolveReloadList!: (s: Session[]) => void
    const b = {
      kind: "live" as const,
      listProjects: async () => [],
      listSessions: () => {
        recentCount++
        return new Promise<Session[]>((r) => (resolveReloadList = r))
      },
      active: async () => {
        activeCount++
        return new Set<string>()
      },
      permissions: async () => [],
      forms: async () => [],
      setAutoApproveAll: async (on: boolean) => {
        autoCalls.push(on)
      },
      subscribe: () => () => {
        unsubCount++
      },
    } as unknown as Backend

    const store = new Store(b)
    expect(store.autoApproveAll).toBe(true)

    // stop() called mid-start must abort reload and prevent pollTimer / recentTimer from starting
    const starting = store.start()
    store.stop()
    resolveReloadList([sess("s1")])
    await starting
    expect(unsubCount).toBe(1)
    expect(store.sessions.size).toBe(0)
    expect(autoCalls).toEqual([true])
    const baseActive = activeCount
    const baseRecent = recentCount
    jest.advanceTimersByTime(60_000)
    expect(activeCount).toBe(baseActive)
    expect(recentCount).toBe(baseRecent)

    // Schedule preview refresh + card flush, then stop() clears both
    ;(store as any).refreshPreviewSoon("s1", 500)
    store.touchCard("s1")
    store.stop()
    expect(store["refreshTimers"].size).toBe(0)
    expect(store["flushScheduled"]).toBe(false)

    // Reconnect reload re-syncs autoApproveAll while toggle off syncs false
    const reloading = store.reload()
    resolveReloadList([sess("s1")])
    await reloading
    expect(autoCalls).toEqual([true, true])

    store.setAutoApproveAll(false)
    expect(storage["hermes-canvas.autoApprove"]).toBe("0")
    expect(autoCalls).toEqual([true, true, false])
  })
})
