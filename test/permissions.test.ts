import { describe, expect, test } from "bun:test"
import type { Backend } from "../src/app/backend"
import { ALLOW_ALL, Store } from "../src/app/store"
import type { PermissionRequest, Session } from "../src/app/types"

function setup() {
  const replies: Array<[string, string, string]> = []
  const patches: Array<[string, unknown]> = []
  const backend = {
    kind: "demo",
    replyPermission: async (sid: string, rid: string, d: string) => void replies.push([sid, rid, d]),
    setSessionPermissions: async (id: string, rules: unknown) => void patches.push([id, rules]),
  } as unknown as Backend
  const store = new Store(backend)
  const mk = (id: string, extra: Partial<Session> = {}): Session => ({
    id,
    projectID: "p",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/x" },
    ...extra,
  })
  store.sessions.set("a", mk("a"))
  store.sessions.set("b", mk("b", { permissions: [{ action: "read", resource: "*", effect: "allow" }] }))
  store.sessions.set("c", mk("c", { parentID: "b" }))
  ;(store as any).rebuildChildren()
  const req = (id: string, sid: string): PermissionRequest => ({ id, sessionID: sid, action: "shell", resources: ["ls"] })
  const ask = (r: PermissionRequest) => (store as any).onEvent({ id: "e", type: "permission.asked", data: r })
  return { store, replies, patches, req, ask }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe("permissions", () => {
  test("asks wait for you by default", async () => {
    const { store, replies, req, ask } = setup()
    ask(req("per_1", "a"))
    await tick()
    expect(replies).toEqual([])
    expect(store.pendingPermissionCount()).toBe(1)
    expect(store.status("a")).toBe("needs-you")
  })

  test("allow all pending approves once, everywhere", async () => {
    const { store, replies, req, ask } = setup()
    ask(req("per_1", "a"))
    ask(req("per_2", "b"))
    const n = await store.approveAllPending()
    expect(n).toBe(2)
    expect(replies.map((r) => r[2])).toEqual(["once", "once"])
    expect(store.pendingPermissionCount()).toBe(0)
  })

  test("global auto-approve clears the backlog and approves new asks", async () => {
    const { store, replies, req, ask } = setup()
    ask(req("per_1", "a"))
    store.setAutoApproveAll(true)
    await tick()
    ask(req("per_2", "a"))
    await tick()
    expect(replies.map((r) => r[1]).sort()).toEqual(["per_1", "per_2"])
    store.setAutoApproveAll(false)
    ask(req("per_3", "a"))
    await tick()
    expect(replies.length).toBe(2)
  })

  test("per-session rule keeps other rules and covers its subagents", async () => {
    const { store, patches, replies, req, ask } = setup()
    ask(req("per_1", "b"))
    await store.setSessionAutoApprove("b", true)
    expect(patches.at(-1)).toEqual(["b", [{ action: "read", resource: "*", effect: "allow" }, ALLOW_ALL]])
    expect(replies.map((r) => r[1])).toEqual(["per_1"])
    expect(store.sessionAutoApproves("c")).toBe(true)
    ask(req("per_2", "c"))
    await tick()
    expect(replies.map((r) => r[1])).toEqual(["per_1", "per_2"])
    await store.setSessionAutoApprove("b", false)
    expect(patches.at(-1)).toEqual(["b", [{ action: "read", resource: "*", effect: "allow" }]])
    expect(store.sessionAutoApproves("b")).toBe(false)
  })

  test("turning auto off on a session with no other rules clears them", async () => {
    const { store, patches } = setup()
    await store.setSessionAutoApprove("a", true)
    await store.setSessionAutoApprove("a", false)
    expect(patches.at(-1)).toEqual(["a", null])
  })

  test("a reload clears asks answered elsewhere while disconnected", async () => {
    const { store, req, ask } = setup()
    ask(req("per_1", "a"))
    expect(store.status("a")).toBe("needs-you")
    // Nothing is running any more and the server has no pending asks.
    Object.assign(store.backend, {
      listProjects: async () => [],
      listSessions: async () => [...store.sessions.values()],
      active: async () => new Set<string>(),
      permissions: async () => [],
      forms: async () => [],
    })
    await store.reload()
    await tick()
    expect(store.pendingPermissionCount()).toBe(0)
    expect(store.status("a")).not.toBe("needs-you")
  })
})
