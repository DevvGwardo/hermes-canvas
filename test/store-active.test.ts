import { describe, expect, it, jest } from "bun:test"
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
    const { store, setPerms, setForms, setFailPerms } = await loadedStore()
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
