import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { makeHermesHome } from "./helpers"
import { startServer } from "../src/server/server"
import { ApiError } from "../src/app/backend"
import { HermesBackend } from "../src/app/hermes-backend"
import { ALLOW_ALL } from "../src/app/store"

// T21: the client half of the Hermes API contract. Layer A runs HermesBackend
// against the REAL server (relative URLs relayed with the origin prefix), so a
// route or method drift on either side fails as a 404/shape error. Layer B
// pins the pure-client mapping, error paths, and request bodies against a
// stubbed fetch. Layer C drives subscribe() through a fake EventSource.

process.env.HERMES_FAKE_MODE = "fast"
const home = makeHermesHome()
const { server, stop } = await startServer({
  port: 0,
  hostname: "127.0.0.1",
  demo: false,
  dev: false,
  quiet: true,
})
const base = `http://127.0.0.1:${server.port}`

type Call = { url: string; method: string; headers?: unknown; body?: unknown }

const realFetch = globalThis.fetch.bind(globalThis)
const relayCalls: Call[] = []

function record(input: unknown, init?: RequestInit): string {
  const url = typeof input === "string" ? input : String((input as Request).url)
  let body: unknown = init?.body
  if (typeof body === "string") {
    try {
      body = JSON.parse(body)
    } catch {
      /* keep raw text */
    }
  }
  relayCalls.push({ url, method: init?.method ?? "GET", headers: init?.headers, body })
  return url
}

// Relay: client paths are relative ("/api/..."), so prefix the live origin.
;(globalThis as any).fetch = async (input: unknown, init?: RequestInit) => {
  const url = record(input, init)
  return realFetch(/^https?:/.test(url) ? url : base + url, init)
}

const last = () => relayCalls[relayCalls.length - 1]

afterAll(() => {
  stop()
  ;(globalThis as any).fetch = realFetch
})

const backend = new HermesBackend()

describe("against the real server", () => {
  test("projects: GET /api/hermes/project maps to canonical dirs", async () => {
    const projects = await backend.listProjects()
    const dirs = projects.map((p) => p.canonical).sort()
    expect(dirs).toEqual(["/repo/alpha", "/repo/beta"])
    expect(last()).toMatchObject({ url: "/api/hermes/project", method: "GET" })
  })

  test("sessions: limit is forwarded and clamped at 600; archived skipped", async () => {
    const few = await backend.listSessions(5)
    expect(few.map((s) => s.id)).toEqual(["ses_new_1", "ses_old_1"]) // newest first
    expect(last().url).toBe("/api/hermes/session?limit=5")

    await backend.listSessions(9999)
    expect(last().url).toBe("/api/hermes/session?limit=600") // client-side clamp
  })

  test("getSession maps a session; unknown id throws ApiError 404 with the server message", async () => {
    const s = await backend.getSession("ses_new_1")
    expect(s).toMatchObject({ title: "Alpha session" })
    expect(last().url).toBe("/api/hermes/session/ses_new_1")

    const err = await backend.getSession("nope").then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(404)
    expect((err as ApiError).message).toBe("session not found") // json.message branch
    expect((err as ApiError).body).toMatchObject({ message: "session not found" })
  })

  test("search: query is encoded on the shared /session route", async () => {
    const hits = await backend.searchSessions("Beta")
    expect(hits.map((s) => s.id)).toEqual(["ses_old_1"])
    expect(last().url).toBe("/api/hermes/session?search=Beta")

    await backend.searchSessions("a b")
    expect(last().url).toBe("/api/hermes/session?search=a%20b")
  })

  test("active: hits /session/active and reads an empty map as an empty set", async () => {
    const running = await backend.active()
    expect(running).toEqual(new Set<string>())
    expect(last()).toMatchObject({ url: "/api/hermes/session/active", method: "GET" })
  })

  test("messages: limit-only and cursor queries page through the session", async () => {
    const p1 = await backend.messages("ses_new_1", 2)
    expect(p1.data.map((m) => m.type)).toEqual(["assistant"])
    expect(p1.cursor?.next).toBeTruthy()
    expect(last().url).toBe("/api/hermes/session/ses_new_1/message?limit=2")

    const next = p1.cursor!.next!
    const p2 = await backend.messages("ses_new_1", 2, next)
    expect(p2.data.map((m) => m.type)).toEqual(["user"])
    expect(last().url).toBe(`/api/hermes/session/ses_new_1/message?cursor=${encodeURIComponent(next)}&limit=2`)
  })

  test("models: list and default map to ModelOption", async () => {
    const models = await backend.listModels()
    expect(models).toContainEqual(expect.objectContaining({ id: "deepseek-v4.1-flash", providerID: "custom" }))
    expect(models.every((m) => m.id && m.providerID && m.name)).toBe(true)
    expect(last().url).toBe("/api/hermes/model")

    const def = await backend.serverDefaultModel()
    expect(def).toMatchObject({ id: "deepseek-v4.1-flash", providerID: "custom" })
    expect(last().url).toBe("/api/hermes/model/default")
  })

  test("folders: fs/list maps directory entries to slash-free paths", async () => {
    mkdirSync(join(home, "projects"), { recursive: true })
    const dirs = await backend.listFolders(home)
    expect(dirs).toEqual([join(home, "projects")]) // files filtered, join() has no trailing slash
    expect(last().url).toBe(`/api/hermes/fs/list?path=${encodeURIComponent(home)}`)
  })

  test("mutations are observable on the server: rename, switchModel, yolo permissions", async () => {
    // rename runs through the hermes CLI (the fake CLI exits 0 without writing
    // the title), so the client contract is the request itself; the model and
    // yolo writes hit state.db directly and are observable as side effects.
    await backend.rename("ses_old_1", "Contract renamed")
    expect(last()).toMatchObject({
      url: "/api/hermes/session/ses_old_1",
      method: "PATCH",
      body: { title: "Contract renamed" },
    })

    await backend.switchModel("ses_old_1", { id: "deepseek-v4.1-flash", providerID: "custom" })
    expect((await backend.getSession("ses_old_1")).model).toMatchObject({
      id: "deepseek-v4.1-flash",
      providerID: "custom",
    })

    const yolo = async () => (await realFetch(`${base}/api/hermes/yolo?session=ses_old_1`)).json()
    await backend.setSessionPermissions("ses_old_1", [ALLOW_ALL])
    expect((await yolo()).yolo).toBe(true)
    await backend.setSessionPermissions("ses_old_1", null)
    expect((await yolo()).yolo).toBe(false)
  })

  test("prompt and markViewed post the bodies the server reads", async () => {
    await backend.prompt("ses_old_1", { text: "ping" })
    expect(last()).toMatchObject({ url: "/api/hermes/session/ses_old_1/prompt", method: "POST" })
    expect(last().body).toEqual({ text: "ping" })
    expect(last().headers).toEqual({ "content-type": "application/json" })

    await backend.markViewed("ses_old_1", 123)
    expect(last().body).toEqual({ idle: 123 })
    expect(last().url).toBe("/api/hermes/session/ses_old_1/view")
  })

  test("createSession posts location and returns the new id", async () => {
    const s = await backend.createSession(home)
    expect(s.id).toMatch(/^canvas-draft-/)
    expect(s.location.directory).toBe(home)
    expect(last()).toMatchObject({ url: "/api/hermes/session", method: "POST" })
    expect(last().body).toEqual({ location: { directory: home } })
  })
})

// ---------------------------------------------------------------------------
// Layer B: stubbed fetch for the client-only rules (mapping, errors, bodies).
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<number, string> = { 200: "OK", 400: "Bad Request", 404: "Not Found", 500: "Internal Server Error" }

type StubOut = { status?: number; json?: unknown; text?: string }

function withStub(handler: (url: string, init?: RequestInit) => StubOut): { calls: Call[]; restore: () => void } {
  const saved = globalThis.fetch
  const calls: Call[] = []
  ;(globalThis as any).fetch = async (input: unknown, init?: RequestInit) => {
    const url = record(input, init)
    calls.push(relayCalls.pop()!) // keep the shared log clean; stub owns its copy
    const out = handler(url, init) ?? {}
    const status = out.status ?? 200
    const text = out.text !== undefined ? out.text : out.json !== undefined ? JSON.stringify(out.json) : ""
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: STATUS_TEXT[status] ?? "Unknown",
      text: async () => text,
    } as Response
  }
  return { calls, restore: () => ((globalThis as any).fetch = saved) }
}

describe("mapping and error paths (stub fetch)", () => {
  test("error messages prefer json.message, then json._tag, then the status line", async () => {
    let out: StubOut = { status: 500, json: { message: "boom" } }
    let stub = withStub(() => out)
    let e = await backend.listProjects().then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(e).toBeInstanceOf(ApiError)
    expect([500, "boom"]).toEqual([(e as ApiError).status, (e as ApiError).message])
    expect((e as ApiError).body).toEqual({ message: "boom" })
    stub.restore()

    out = { status: 500, json: { _tag: "ParseError" } }
    stub = withStub(() => out)
    e = await backend.listProjects().then(
      () => undefined,
      (err: unknown) => err,
    )
    expect((e as ApiError).message).toBe("ParseError")
    stub.restore()

    out = { status: 500, text: "not json" }
    stub = withStub(() => out)
    e = await backend.listProjects().then(
      () => undefined,
      (err: unknown) => err,
    )
    expect((e as ApiError).message).toBe("500 Internal Server Error")
    expect((e as ApiError).body).toBe("not json") // unparseable body passes through raw
    stub.restore()

    out = { status: 404, json: {} }
    stub = withStub(() => out)
    e = await backend.listProjects().then(
      () => undefined,
      (err: unknown) => err,
    )
    expect((e as ApiError).message).toBe("404 Not Found")
    stub.restore()
  })

  test("empty and null payloads degrade to empty collections", async () => {
    let stub = withStub(() => ({ text: "" })) // no body at all
    expect(await backend.listProjects()).toEqual([])
    stub.restore()

    stub = withStub(() => ({ json: null }))
    expect(await backend.listProjects()).toEqual([])
    expect(await backend.active()).toEqual(new Set<string>())
    expect(await backend.serverDefaultModel()).toBeUndefined()
    stub.restore()

    stub = withStub(() => ({ json: {} })) // Page without data
    expect(await backend.listSessions(10)).toEqual([])
    expect(await backend.messages("x", 5)).toEqual({} as never)
    stub.restore()
  })

  test("active keeps only entries whose type is running", async () => {
    const stub = withStub(() => ({
      json: { a: { type: "running" }, b: { type: "idle" }, c: { type: "running" } },
    }))
    expect(await backend.active()).toEqual(new Set(["a", "c"]))
    stub.restore()
  })

  test("ids and queries are encodeURIComponent'd in URLs", async () => {
    const stub = withStub(() => ({ json: {} }))
    await backend.getSession("ses x/1?y")
    expect(stub.calls.at(-1)!.url).toBe("/api/hermes/session/ses%20x%2F1%3Fy")
    await backend.messages("a b", 3, "cur/1")
    expect(stub.calls.at(-1)!.url).toBe("/api/hermes/session/a%20b/message?cursor=cur%2F1&limit=3")
    stub.restore()
  })

  test("models coerce to strings and fall back to id for a missing name", async () => {
    const stub = withStub(() => ({ json: [{ id: 7, providerID: 3, name: null }, { id: "x", providerID: "y" }] }))
    expect(await backend.listModels()).toEqual([
      { id: "7", providerID: "3", name: "7" },
      { id: "x", providerID: "y", name: "x" },
    ])
    stub.restore()
  })

  test("folders keep directories only, strip trailing slashes, tolerate missing data", async () => {
    let stub = withStub(() => ({ json: { data: [{ path: "/a/b/", type: "directory" }, { path: "/a/c", type: "file" }] } }))
    expect(await backend.listFolders("/a")).toEqual(["/a/b"])
    stub.restore()

    stub = withStub(() => ({ json: {} }))
    expect(await backend.listFolders("/a")).toEqual([])
    stub.restore()
  })

  test("request bodies: optional fields included only when present", async () => {
    let stub = withStub(() => ({ json: { id: "s", location: { directory: "/d" } } }))
    await backend.createSession("/d")
    expect(stub.calls.at(-1)!.body).toEqual({ location: { directory: "/d" } })
    await backend.createSession("/d", { id: "m", providerID: "p" })
    expect(stub.calls.at(-1)!.body).toEqual({ location: { directory: "/d" }, model: { id: "m", providerID: "p" } })
    await backend.createSession("/d", undefined, [])
    expect(stub.calls.at(-1)!.body).toEqual({ location: { directory: "/d" } }) // empty rules dropped
    await backend.createSession("/d", undefined, [ALLOW_ALL])
    expect(stub.calls.at(-1)!.body).toEqual({ location: { directory: "/d" }, permissions: [ALLOW_ALL] })
    stub.restore()

    stub = withStub(() => ({ json: { ok: true } }))
    await backend.prompt("s", { text: "hi" })
    expect(stub.calls.at(-1)!.body).toEqual({ text: "hi" })
    // files are a no-op in Hermes mode (the server prompt route reads text/delivery only)
    await backend.prompt("s", { text: "hi", delivery: { to: "x" } as never, files: [{ uri: "file:///a" }] })
    expect(stub.calls.at(-1)!.body).toEqual({ text: "hi", delivery: { to: "x" } })
    await backend.rename("s", "Title")
    expect(stub.calls.at(-1)!.body).toEqual({ title: "Title" })
    await backend.setSessionPermissions("s", [ALLOW_ALL])
    expect(stub.calls.at(-1)!.body).toEqual({ permissions: [ALLOW_ALL] })
    await backend.setSessionPermissions("s", null)
    expect(stub.calls.at(-1)!.body).toEqual({ permissions: null })
    await backend.switchModel("s", { id: "i", providerID: "p" })
    expect(stub.calls.at(-1)!.body).toEqual({ model: { id: "i", providerID: "p" } })
    await backend.markViewed("s", 9)
    expect(stub.calls.at(-1)!.body).toEqual({ idle: 9 })
    // no body -> no content-type header, even on POST
    await backend.interrupt("s")
    expect(stub.calls.at(-1)).toMatchObject({ url: "/api/hermes/session/s/interrupt", method: "POST", headers: undefined, body: undefined })
    stub.restore()
  })

  test("Hermes has no queues: reads answer [] and replies no-op without a fetch", async () => {
    const stub = withStub(() => ({ json: [] }))
    const before = stub.calls.length
    // The class declares these with no parameters (Hermes never sends them).
    expect(await backend.inbox()).toEqual([])
    expect(await backend.permissions()).toEqual([])
    expect(await backend.forms()).toEqual([])
    await backend.replyPermission()
    await backend.replyForm()
    await backend.cancelForm()
    await backend.setInboxDelivery()
    await backend.cancelInbox()
    expect(stub.calls.length).toBe(before) // zero network traffic
    stub.restore()
  })
})

// ---------------------------------------------------------------------------
// Layer C: subscribe() - the SSE lifecycle behind a fake EventSource.
// ---------------------------------------------------------------------------

type FakeES = {
  url: string
  onopen: (() => void) | null
  onmessage: ((m: { data: string }) => void) | null
  onerror: (() => void) | null
  closed: boolean
  close(): void
}
const esLog: FakeES[] = []
class FakeEventSource {
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) {
    esLog.push(this)
  }
  close() {
    this.closed = true
  }
}

describe("subscribe (fake EventSource)", () => {
  const savedES = (globalThis as any).EventSource
  beforeAll(() => {
    (globalThis as any).EventSource = FakeEventSource
    esLog.length = 0
  })
  afterAll(() => {
    if (savedES === undefined) delete (globalThis as any).EventSource
    else (globalThis as any).EventSource = savedES
  })

  test("announces connecting, goes live on server.connected, drops malformed frames", () => {
    esLog.length = 0
    const states: string[] = []
    const events: Array<{ type?: string }> = []
    const unsub = backend.subscribe((ev) => events.push(ev), (s) => states.push(s))
    expect(states).toEqual(["connecting"])
    expect(esLog).toHaveLength(1)
    expect(esLog[0].url).toBe("/api/hermes/event")

    esLog[0].onmessage!({ data: "not json" })
    expect(events).toHaveLength(0) // parse failure: silently dropped
    expect(states).toEqual(["connecting"])

    esLog[0].onmessage!({ data: JSON.stringify({ type: "server.connected" }) })
    expect(states).toEqual(["connecting", "live"]) // the hello frame is what reports live
    expect(events).toEqual([{ type: "server.connected" }])

    esLog[0].onmessage!({ data: JSON.stringify({ type: "session.text.delta" }) })
    expect(events).toHaveLength(2)
    expect(states).toEqual(["connecting", "live"]) // ordinary events do not touch state
    unsub()
  })

  test("errors reconnect with 500 -> 10000 exponential backoff", () => {
    jest.useFakeTimers()
    try {
      esLog.length = 0
      const states: string[] = []
      const unsub = backend.subscribe(() => {}, (s) => states.push(s))
      const gaps = [500, 1000, 2000, 4000, 8000, 10000, 10000] // doubling, capped at 10s
      for (let i = 0; i < gaps.length; i++) {
        const es = esLog[esLog.length - 1]
        es.onerror!()
        expect(states[states.length - 1]).toBe("reconnecting")
        expect(es.closed).toBe(true) // broken stream is closed before retrying
        jest.advanceTimersByTime(gaps[i])
        expect(esLog).toHaveLength(1 + i + 1) // exactly one reconnect per window
        expect(esLog[esLog.length - 1].url).toBe("/api/hermes/event")
      }
      expect(states.filter((s) => s === "connecting")).toHaveLength(1) // connect-once at subscribe()
      expect(states.filter((s) => s === "reconnecting")).toHaveLength(gaps.length)
      unsub()
    } finally {
      jest.useRealTimers()
    }
  })

  test("unsubscribe closes the stream and cancels a pending reconnect", () => {
    jest.useFakeTimers()
    try {
      esLog.length = 0
      const states: string[] = []
      const unsub = backend.subscribe(() => {}, (s) => states.push(s))
      esLog[0].onerror!()
      expect(states[states.length - 1]).toBe("reconnecting")
      unsub()
      expect(esLog[0].closed).toBe(true)
      jest.advanceTimersByTime(60_000)
      expect(esLog).toHaveLength(1) // the scheduled retry never fires
      esLog[0].onerror!() // and a late error on the closed source announces nothing
      expect(states.filter((s) => s === "reconnecting")).toHaveLength(1)
      expect(states[states.length - 1]).toBe("reconnecting")
    } finally {
      jest.useRealTimers()
    }
  })

  test("a successful open resets the backoff before the next failure", () => {
    jest.useFakeTimers()
    try {
      esLog.length = 0
      const unsub = backend.subscribe(() => {}, () => {})
      esLog[0].onopen!() // initial open: already at the base delay
      esLog[0].onerror!() // schedules at 500, retry doubles to 1000
      jest.advanceTimersByTime(500)
      expect(esLog).toHaveLength(2)

      esLog[1].onopen!() // the stream came up: backoff returns to the base
      esLog[1].onerror!() // schedules at 500 again - NOT at 1000
      jest.advanceTimersByTime(500)
      expect(esLog).toHaveLength(3) // would still be 2 if the open never reset retry
      unsub()
    } finally {
      jest.useRealTimers()
    }
  })
})
