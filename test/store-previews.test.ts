import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { Store, buildPreview } from "../src/app/store"
import { previewBlocks } from "../src/app/markdown"
import type { Backend, ConnectionState } from "../src/app/backend"
import type { Message, OcEvent, Session } from "../src/app/types"

// The card preview pipeline: wantPreview dedupe, the 4-deep newest-first
// pump, success/failure handling, reload-stale semantics, and the
// event-driven refresh that streams fire when a turn ends - plus title()'s
// fallback chain, which consumes preview data. A controllable fake backend
// holds every messages() promise so inflight limits and ordering are exact.
// The same fixture drives start()'s connection state machine: a failed
// reconnect resync is swallowed and still lands live.

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

const page = (data: Message[]) => ({ data, cursor: {} })
const user = (text: string): Message => ({ type: "user", id: "mu", time: { created: 1 }, text })
const assistant = (text: string): Message => ({
  type: "assistant",
  id: "ma",
  time: { created: 1 },
  agent: "a",
  model: { id: "m", providerID: "p" },
  content: [{ type: "text", text }],
})
const session = (id: string, title?: string): Session => ({ id, title } as unknown as Session)

function fakeBackend() {
  const calls: string[] = []
  const pending: Array<{ id: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = []
  let onEvent: ((ev: OcEvent) => void) | undefined
  let notifyState: ((s: ConnectionState) => void) | undefined
  let failList = false
  const backend = {
    kind: "live" as const,
    listProjects: async () => [],
    listSessions: async () => {
      if (failList) throw new Error("server down")
      return []
    },
    active: async () => new Set<string>(),
    inbox: async () => [],
    permissions: async () => [],
    forms: async () => [],
    messages(id: string) {
      calls.push(id)
      return new Promise((resolve, reject) => pending.push({ id, resolve, reject }))
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
    subscribe(onEv: (ev: OcEvent) => void, onState: (s: ConnectionState) => void) {
      onEvent = onEv
      notifyState = onState
      onState("live")
      return () => {
        onEvent = undefined
      }
    },
  }
  return {
    backend: backend as unknown as Backend,
    calls,
    pending,
    emit: (ev: OcEvent) => onEvent?.(ev),
    setState: (s: ConnectionState) => notifyState?.(s),
    setFailList: (f: boolean) => {
      failList = f
    },
  }
}

let fx: ReturnType<typeof fakeBackend>
let store: Store

beforeEach(() => {
  fx = fakeBackend()
  store = new Store(fx.backend)
})

afterEach(() => {
  store.stop() // clears start()'s poll/recent timers
  jest.useRealTimers()
})

test("wantPreview fetches once, dedupes in flight, and stops refetching a fresh cache", async () => {
  store.wantPreview("a")
  expect(fx.calls).toEqual(["a"]) // pumped synchronously
  store.wantPreview("a")
  store.wantPreview("a")
  expect(fx.calls).toEqual(["a"]) // queued set absorbs the repeats

  fx.pending[0].resolve(page([assistant("did the thing")]))
  await flush()
  expect(store.previews.get("a")).toEqual(previewBlocks("did the thing"))

  store.wantPreview("a")
  expect(fx.calls).toEqual(["a"]) // fresh cache: never refetches
})

test("title falls back to the preview's pending user question, then to New session", () => {
  const long = "x".repeat(100)
  store.previews.set("s1", { text: "", bullets: [], pendingUser: long })
  expect(store.title(session("s1", "  Padded title  "))).toBe("Padded title") // real title wins, trimmed
  expect(store.title(session("s1", "   "))).toBe(long.slice(0, 80)) // blank title -> pending user, capped
  expect(store.title(session("s1"))).toBe(long.slice(0, 80))
  expect(store.title(session("s2"))).toBe("New session") // nothing known at all
})

test("pump runs at most 4 inflight and drains the queue newest-first", async () => {
  for (const id of ["a", "b", "c", "d", "e", "f"]) store.wantPreview(id)
  expect(fx.calls).toEqual(["a", "b", "c", "d"]) // PREVIEW_CONCURRENCY = 4
  expect(fx.pending).toHaveLength(4) // e and f wait in the queue

  fx.pending.find((p) => p.id === "a")!.resolve(page([assistant("A")]))
  await flush()
  expect(fx.calls).toEqual(["a", "b", "c", "d", "f"]) // pop() takes the queue end

  fx.pending.find((p) => p.id === "b")!.resolve(page([assistant("B")]))
  await flush()
  expect(fx.calls).toEqual(["a", "b", "c", "d", "f", "e"])
})

test("failures: placeholder with nothing cached, existing preview retained, still stale", async () => {
  store.wantPreview("x")
  fx.pending[0].reject(new Error("offline"))
  await flush()
  expect(store.previews.get("x")).toEqual({ text: "", bullets: [] }) // cards show empty, not a crash

  store.wantPreview("y")
  fx.pending[1].resolve(page([assistant("cached answer")]))
  await flush()
  const cached = store.previews.get("y")!
  expect(cached).toEqual(previewBlocks("cached answer"))

  await store.reload() // reconnect marks every preview stale (reload semantics)
  store.wantPreview("y")
  expect(fx.calls).toEqual(["x", "y", "y"]) // stale -> refetch
  fx.pending[2].reject(new Error("offline"))
  await flush()
  expect(store.previews.get("y")).toEqual(cached) // last good preview survives

  store.wantPreview("y")
  expect(fx.calls).toEqual(["x", "y", "y", "y"]) // a failed refresh stays stale
})

test("buildPreview reads newest-first: answered, pending, unanswered, empty answers", () => {
  expect(buildPreview([assistant("done")])).toEqual(previewBlocks("done"))
  expect(buildPreview([user("please deploy"), assistant("earlier")])).toEqual({
    ...previewBlocks("earlier"),
    pendingUser: "please deploy",
  })
  expect(buildPreview([user("only question")])).toEqual({ text: "", bullets: [], pendingUser: "only question" })
  // ANY assistant entry marks answered, even an empty one...
  expect(buildPreview([assistant(""), user("older question")])).toEqual({ text: "", bullets: [] })
  // ...but a question NEWER than the empty reply survives: nothing answered it.
  expect(buildPreview([user("never answered"), assistant("")])).toEqual({
    text: "",
    bullets: [],
    pendingUser: "never answered",
  })
})

test("session.text.ended refreshes the preview once per burst, then clears staleness", async () => {
  jest.useFakeTimers()
  try {
    await store.start() // wires onEvent through the fake's subscribe

    store.wantPreview("a")
    fx.pending[0].resolve(page([assistant("first answer")]))
    await flush()
    expect(store.previews.get("a")).toEqual(previewBlocks("first answer"))

    // Two end-of-turn events inside the window collapse into ONE refresh.
    fx.emit({ id: "e1", type: "session.text.ended", data: { sessionID: "a" } })
    fx.emit({ id: "e2", type: "session.text.ended", data: { sessionID: "a" } })
    expect(fx.calls).toEqual(["a"]) // still inside the 300ms window
    jest.advanceTimersByTime(300)
    expect(fx.calls).toEqual(["a", "a"]) // exactly one refetch for the burst

    fx.pending[1].resolve(page([assistant("second answer")]))
    await flush()
    expect(store.previews.get("a")).toEqual(previewBlocks("second answer")) // refreshed in place
    store.wantPreview("a")
    expect(fx.calls).toEqual(["a", "a"]) // success cleared the stale mark

    // A later burst schedules the next refresh.
    fx.emit({ id: "e3", type: "session.text.ended", data: { sessionID: "a" } })
    jest.advanceTimersByTime(300)
    expect(fx.calls).toEqual(["a", "a", "a"])
  } finally {
    jest.useRealTimers()
  }
})

test("a failed resync after a reconnect still lands live", async () => {
  await store.start() // healthy: the initial load succeeds
  fx.setFailList(true) // the server drops while we are disconnected
  fx.setState("reconnecting")
  expect(store.connection).toBe("reconnecting")
  fx.setState("live") // wasReconnecting -> the resync reload is fired and swallowed
  await flush()
  expect(store.connection).toBe("live") // the failed resync did not wedge the state
  expect(store.sessions.size).toBe(0) // and the store was left as it was
})
