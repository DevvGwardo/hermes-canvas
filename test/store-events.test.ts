import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { Store } from "../src/app/store"
import type { Backend } from "../src/app/backend"
import type { Session } from "../src/app/types"

// The Store's session.* event switch: created + its refetch, execution
// outcomes, the setActivity label cluster, the patch-backed usage/model/
// renamed branches, deletion, liveText accumulation and inbox staging.
// permissions.test.ts owns permission.asked and store-previews owns the
// preview pump + text.ended; no file fired these session branches at all
// (coverage's nine listed ranges were only a sample of the gap). It also
// pins the two getSession swallows: a failed refetch never loses the
// record already in the map.

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

const usage = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

const record = (id: string, title = "seeded"): Session =>
  ({
    id,
    title,
    projectID: "p",
    cost: 1,
    tokens: usage(),
    time: { created: 1, updated: 1 },
    location: { directory: "/w" },
  }) as unknown as Session

function fakeBackend() {
  let failGet = false
  const backend = {
    kind: "live" as const,
    listProjects: async () => [],
    listSessions: async () => [],
    active: async () => new Set<string>(),
    inbox: async () => [],
    permissions: async () => [],
    forms: async () => [],
    messages: async () => ({ data: [], cursor: {} }),
    getSession: async (id: string) => {
      if (failGet) throw new Error("refetch down")
      return record(id, `refetched ${id}`)
    },
    createSession: async () => {
      throw new Error("unused")
    },
    setSessionPermissions: async () => {},
    listModels: async () => [],
    serverDefaultModel: async () => undefined,
    listFolders: async () => [],
    switchModel: async () => {},
    prompt: async () => {},
    interrupt: async () => {},
    markViewed: async () => {},
    rename: async () => {},
    setInboxDelivery: async () => {},
    cancelInbox: async () => {},
    replyPermission: async () => {},
    replyForm: async () => {},
    cancelForm: async () => {},
    subscribe: (..._args: unknown[]) => () => {},
  } as unknown as Backend
  return { backend, setFailGet: (f: boolean) => { failGet = f } }
}

let store: Store
let fx: ReturnType<typeof fakeBackend>
const fire = (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  (store as any).onEvent({ id: "e", type, data, ...extra })

beforeEach(() => {
  fx = fakeBackend()
  store = new Store(fx.backend)
})

afterEach(() => {
  store.stop() // clears any timers the events scheduled
  jest.useRealTimers()
})

describe("Store — the session event switch", () => {
  test("session.created builds a record, wires its child, and swaps in the refetched row", async () => {
    fire("session.created", { sessionID: "p1", title: "parent" }, { created: 5 })
    expect(store.sessions.get("p1")).toMatchObject({
      id: "p1",
      title: "parent",
      time: { created: 5, updated: 5 },
      location: { directory: "" },
    })
    expect(store["structureDirty"]).toBe(true) // marked while the fetch is inflight

    fire("session.created", { sessionID: "c1", parentID: "p1", title: "child" })
    expect(store.subagentCount("p1")).toBe(1) // inline child wiring before any fetch
    expect(store["dirtyCards"].has("p1")).toBe(true) // touchCard(parent) for re-render

    await flush()
    // The refetch replaces the event-built row (the event lacks fields on forks).
    expect(store.sessions.get("p1")!.title).toBe("refetched p1")
    expect(store.sessions.get("c1")!.title).toBe("refetched c1")
    expect(store.sessions.size).toBe(2)
  })

  test("addSessions rebuilds children so subagentCount reports real links", () => {
    expect(store.subagentCount("p1")).toBe(0) // nothing known yet: the ?? 0 arm
    store.addSessions([record("p1"), { ...record("c1"), parentID: "p1" }])
    expect(store.sessions.size).toBe(2)
    expect(store.subagentCount("p1")).toBe(1) // rebuildChildren linked the pair
    expect(store.subagentCount("c1")).toBe(0) // a leaf has no children entry
    expect(store["structureDirty"]).toBe(true) // addSessions marks structure
  })

  test("execution events drive running state, outcomes and timestamps", () => {
    store.addSessions([record("s1")])
    fire("session.text.started", { sessionID: "s1" })
    expect(store["liveText"].has("s1")).toBe(true)

    fire("session.execution.started", { sessionID: "s1" })
    expect(store.running.has("s1")).toBe(true)
    expect(store["activity"].get("s1")).toBe("Working…")
    expect(store["liveText"].has("s1")).toBe(false) // a fresh turn drops stale live text

    fire("session.execution.failed", { sessionID: "s1" }, { created: 7 })
    expect(store.running.has("s1")).toBe(false)
    expect(store["activity"].has("s1")).toBe(false)
    expect(store.sessions.get("s1")!.outcome).toBe("failed")
    expect(store.sessions.get("s1")!.time).toMatchObject({ updated: 7, idle: 7 })

    fire("session.execution.started", { sessionID: "s1" })
    fire("session.execution.succeeded", { sessionID: "s1" }, { created: 9 })
    expect(store.sessions.get("s1")!.outcome).toBe("succeeded")
    expect(store.sessions.get("s1")!.time.updated).toBe(9)

    fire("session.execution.started", { sessionID: "s1" })
    fire("session.execution.interrupted", { sessionID: "s1" })
    expect(store.sessions.get("s1")!.outcome).toBe("interrupted")
    expect(store.running.has("s1")).toBe(false)
  })

  test("activity labels add running, dedupe repeats and skip a missing session", () => {
    store.addSessions([record("s1")])
    fire("session.tool.input.started", { sessionID: "s1", id: "t1", name: "bash" })
    expect(store["activity"].get("s1")).toBe("Running a command…") // describeTool("bash")
    expect(store.running.has("s1")).toBe(true) // setActivity ensures the session counts as running

    fire("session.tool.called", { sessionID: "s1", id: "t1", input: { command: "ls" } })
    expect(store["activity"].get("s1")).toBe("Running ls…") // remembered tool name + input

    const same = store["activity"].get("s1")
    fire("session.tool.called", { sessionID: "s1", id: "t1", input: { command: "ls" } })
    expect(store["activity"].get("s1")).toBe(same) // identical label hits the dedupe return

    fire("session.tool.success", { sessionID: "s1", id: "t1" })
    expect(store["activity"].get("s1")).toBe("Working…")
    expect(store["toolNames"].has("t1")).toBe(false)

    fire("session.reasoning.started", { sessionID: "s1" })
    expect(store["activity"].get("s1")).toBe("Thinking…")
    fire("session.reasoning.ended", { sessionID: "s1" })
    expect(store["activity"].get("s1")).toBe("Working…")
    fire("session.reasoning.started", { sessionID: "s1" })
    expect(store["activity"].get("s1")).toBe("Thinking…")
    fire("session.execution.succeeded", { sessionID: "s1" })
    // A late reasoning delta must not resurrect "thinking" for a finished turn.
    fire("session.reasoning.delta", { sessionID: "s1" })
    expect(store.running.has("s1")).toBe(false)
    expect(store["activity"].has("s1")).toBe(false)
    fire("session.execution.started", { sessionID: "s1" })
    fire("session.compaction.started", { sessionID: "s1" })
    expect(store["activity"].get("s1")).toBe("Compacting context…")
    fire("session.retry.scheduled", { sessionID: "s1" })
    expect(store["activity"].get("s1")).toBe("Retrying…")

    const before = store["activity"].size
    fire("session.text.started") // no sessionID -> setActivity's early return
    expect(store["activity"].size).toBe(before)
    expect(store.running.has("s1")).toBe(true) // and the running set is untouched
  })

  test("usage and model events patch the record and fall back to what it had", () => {
    store.addSessions([
      { ...record("s1"), model: { providerID: "prov", id: "m1" } } as unknown as Session,
    ])

    fire("session.usage.updated", { sessionID: "s1", cost: 9.5, tokens: { ...usage(), input: 5 } })
    expect(store.sessions.get("s1")!.cost).toBe(9.5)
    expect(store.sessions.get("s1")!.tokens.input).toBe(5)

    fire("session.usage.updated", { sessionID: "s1" })
    expect(store.sessions.get("s1")!.cost).toBe(9.5) // missing cost keeps the old value
    expect(store.sessions.get("s1")!.tokens.input).toBe(5) // same for tokens

    fire("session.model.selected", { sessionID: "s1", model: { providerID: "prov", id: "m2" } })
    expect(store.sessions.get("s1")!.model).toEqual({ providerID: "prov", id: "m2" })
    fire("session.model.selected", { sessionID: "s1" })
    expect(store.sessions.get("s1")!.model).toEqual({ providerID: "prov", id: "m2" }) // no model keeps it
  })

  test("renames patch, forks and moves refetch, deletes rebuild", async () => {
    jest.useFakeTimers()
    try {
      store.addSessions([record("s1")])
      jest.advanceTimersByTime(300) // drain the first flush so structure starts clean
      expect(store["structureDirty"]).toBe(false)

      fire("session.renamed", { sessionID: "s1", title: "Renamed" })
      expect(store.sessions.get("s1")!.title).toBe("Renamed")
      expect(store["structureDirty"]).toBe(true) // a structural patch marks structure

      fire("session.forked", { sessionID: "s9" })
      fire("session.moved", { sessionID: "s8" })
      await flush()
      expect(store.sessions.get("s9")!.title).toBe("refetched s9") // getSession.then ran
      expect(store.sessions.get("s8")!.title).toBe("refetched s8")

      fire("session.deleted", { sessionID: "s1" })
      expect(store.sessions.has("s1")).toBe(false)
      expect(store["structureDirty"]).toBe(true) // delete marks structure as well
      fire("session.deleted", { sessionID: "ghost" }) // unknown id: the false arm
      expect(store.sessions.size).toBe(2) // s9 + s8 remain
    } finally {
      jest.useRealTimers()
    }
  })

  test("text deltas accumulate into liveText and inbox enqueueing stages the question", () => {
    store.addSessions([record("s1")])
    fire("session.text.started", { sessionID: "s1" })
    expect(store["liveText"].get("s1")).toBe("")
    expect(store["activity"].get("s1")).toBe("Writing…")

    fire("session.text.delta", { sessionID: "s1", delta: "Hello " })
    fire("session.text.delta", { sessionID: "s1", delta: "world" })
    expect(store["liveText"].get("s1")).toBe("Hello world")

    fire("session.text.delta", { sessionID: "s1", delta: "x".repeat(700) })
    expect(store["liveText"].get("s1")).toHaveLength(600) // the live buffer caps at 600 chars

    fire("session.text.delta", { delta: "ghost" }) // no sessionID -> break
    expect(store["liveText"].size).toBe(1)

    fire("session.inbox.enqueued", { sessionID: "s1", item: { type: "user", payload: { text: "q?" } } })
    expect(store.previews.get("s1")).toEqual({ text: "", bullets: [], pendingUser: "q?" })
    fire("session.inbox.enqueued", { sessionID: "s1", item: { type: "notice" } })
    expect(store.previews.get("s1")!.pendingUser).toBe("q?") // non-user items never stage a question
  })

  test("a failed created-refetch keeps the event-built stub instead of losing the session", async () => {
    fx.setFailGet(true)
    fire("session.created", { sessionID: "p1", title: "parent" }, { created: 5 })
    expect(store.sessions.get("p1")!.title).toBe("parent") // the stub stands while inflight
    await flush() // the refetch rejects; the catch swallows it
    expect(store.sessions.get("p1")!.title).toBe("parent")
    expect(store.sessions.size).toBe(1)
  })

  test("a failed moved refetch keeps the previous record", async () => {
    store.addSessions([record("s1", "original")])
    fx.setFailGet(true)
    fire("session.moved", { sessionID: "s1" })
    await flush() // the catch swallows it
    expect(store.sessions.get("s1")!.title).toBe("original")
  })
})
