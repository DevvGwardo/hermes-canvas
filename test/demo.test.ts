import { describe, expect, test } from "bun:test"
import { DemoBackend } from "../src/app/demo"
import { Store } from "../src/app/store"

// Demo mode is the documented way to run the canvas without a Hermes install
// (`bun run demo`, `?demo=1`, and what CONTRIBUTING tells contributors to try UI
// changes against), so its backend is held to the same contract the app relies on.

async function seeded() {
  const backend = new DemoBackend()
  const [projects, sessions] = await Promise.all([backend.listProjects(), backend.listSessions()])
  const store = new Store(backend)
  for (const s of sessions) store.sessions.set(s.id, s)
  ;(store as any).rebuildChildren()
  for (const id of await backend.active()) store.running.add(id)
  return { backend, projects, sessions, store }
}

describe("demo backend", () => {
  test("every session resolves to a seeded project", async () => {
    const { projects, sessions } = await seeded()
    const ids = new Set(projects.map((p) => p.id))
    expect(projects.length).toBeGreaterThan(0)
    expect(sessions.length).toBeGreaterThan(projects.length) // subagents nest under projects
    for (const s of sessions) expect(ids.has(s.projectID)).toBe(true)
    expect(sessions.some((s) => s.parentID)).toBe(true) // subagent cards
  })

  test("sessions carry the shape the canvas renders", async () => {
    const { sessions } = await seeded()
    for (const s of sessions) {
      expect(s.id).toBeString()
      expect(s.title).toBeString()
      expect(s.location.directory).toBeString()
      expect(s.time.created).toBeNumber()
      expect(s.cost).toBeNumber()
      expect(s.tokens).toMatchObject({ input: expect.any(Number), output: expect.any(Number) })
    }
  })

  test("demo exercises every status colour the theme ships", async () => {
    const { sessions, store } = await seeded()
    const now = Date.now()
    const seen = new Set(sessions.map((s) => store.status(s.id, now)))
    for (const st of ["working", "review", "failed", "stopped"] as const) expect(seen.has(st)).toBe(true)
    // A waiting permission is what puts a card in the last remaining state.
    const blocked = sessions.find((s) => store.status(s.id, now) === "working")!
    store.permissions.set(blocked.id, [{ id: "per_1", sessionID: blocked.id, action: "shell", resources: [] }])
    expect(store.status(blocked.id, now)).toBe("needs-you")
  })

  test("serves transcripts and the new-session folder autocompletion", async () => {
    const { backend, sessions } = await seeded()
    const page = await backend.messages(sessions[0].id, 20)
    expect(page.data.length).toBeGreaterThan(0)
    expect(await backend.listFolders("/Users/you")).toEqual(["code", "Desktop", "Documents"])
    expect(await backend.listFolders("/elsewhere")).toEqual([])
    const codeDirs = await backend.listFolders("/Users/you/code")
    expect(codeDirs).toContain("storefront-web")
    expect(codeDirs.at(-1)).toBe("new-idea")
  })

  test("subscribe signs on as demo and goes quiet after unsubscribe", async () => {
    const backend = new DemoBackend()
    const events: Array<{ type: string }> = []
    const states: string[] = []
    const off = backend.subscribe((ev) => events.push({ type: ev.type }), (s) => states.push(s))
    await Bun.sleep(10)
    expect(states).toEqual(["demo"])
    expect(events.map((e) => e.type)).toContain("server.connected")
    off()
    const before = events.length
    await backend.rename("nope", "x").catch(() => {})
    // rename on an unknown id still emits via the session branch only when found;
    // the point here is the listener is gone: a create must not reach it.
    await backend.createSession("/Users/you/code/quiet-check")
    expect(events.length).toBe(before)
  })

  test("search, get, and message paging are case-insensitive and cloned", async () => {
    const { backend } = await seeded()
    const hits = await backend.searchSessions("CHECKOUT")
    expect(hits.map((s) => s.title)).toEqual(["Checkout redesign"])
    const one = await backend.getSession(hits[0]!.id)
    one.title = "mutated"
    expect((await backend.getSession(hits[0]!.id)).title).not.toBe("mutated")
    await expect(backend.getSession("nope")).rejects.toThrow("Session not found")
    const page = await backend.messages(hits[0]!.id, 1)
    expect(page.data).toHaveLength(1)
    expect(page.cursor!.next).toBeTruthy() // seeded transcript is 2+ rows, so limit 1 pages
  })

  test("queues read empty by default; models and the default are fixed demo rows", async () => {
    const backend = new DemoBackend()
    const sessions = await backend.listSessions()
    const idle = sessions.find((s) => s.title === "Image CDN migration")!
    expect(await backend.inbox(idle.id)).toEqual([])
    expect(await backend.permissions(idle.id)).toEqual([])
    expect(await backend.forms(idle.id)).toEqual([])
    const models = await backend.listModels()
    expect(models.map((m) => m.id)).toContain("demo-model")
    expect(await backend.serverDefaultModel()).toMatchObject({ id: "demo-model", providerID: "demo" })
    // the one seeded permission lives on Refund webhooks
    const blocked = sessions.find((s) => s.title === "Refund webhooks")!
    expect(await backend.permissions(blocked.id)).toHaveLength(1)
  })

  test("switchModel, markViewed, rename, and permission-rule writes stick", async () => {
    const backend = new DemoBackend()
    const events: Array<{ type: string; data: any }> = []
    backend.subscribe((ev) => events.push({ type: ev.type, data: (ev as any).data }), () => {})
    const sessions = await backend.listSessions()
    const s = sessions.find((x) => x.title === "Image CDN migration")!
    await backend.switchModel(s.id, { id: "claude-opus-5-5", providerID: "anthropic" })
    expect((await backend.getSession(s.id)).model).toEqual({ id: "claude-opus-5-5", providerID: "anthropic" })
    expect(events.some((e) => e.type === "session.model.selected")).toBe(true)
    await backend.markViewed(s.id, 12345)
    expect((await backend.getSession(s.id)).time.viewed).toBe(12345)
    await backend.rename(s.id, "CDN+AVIF")
    expect((await backend.getSession(s.id)).title).toBe("CDN+AVIF")
    await backend.setSessionPermissions(s.id, [{ action: "shell", resource: "*", effect: "allow" }])
    expect((await backend.getSession(s.id)).permissions).toEqual([{ action: "shell", resource: "*", effect: "allow" }])
  })

  test("createSession opens a project for a new directory and reuses an existing one", async () => {
    const backend = new DemoBackend()
    const beforeCount = (await backend.listProjects()).length
    const fresh = await backend.createSession("/Users/you/code/some-new-dir")
    expect((await backend.listProjects()).length).toBe(beforeCount + 1)
    expect(fresh.location.directory).toBe("/Users/you/code/some-new-dir")
    const again = await backend.createSession("/Users/you/code/some-new-dir")
    expect(again.projectID).toBe(fresh.projectID)
    expect((await backend.listProjects()).length).toBe(beforeCount + 1)
  })

  test("queued prompts wait for the running turn; cancel and reply clear them", async () => {
    const backend = new DemoBackend()
    const events: Array<{ type: string; data: any }> = []
    backend.subscribe((ev) => events.push({ type: ev.type, data: (ev as any).data }), () => {})
    const sessions = await backend.listSessions()
    const idle = sessions.find((s) => s.title === "Image CDN migration")!
    // first prompt starts a loop (running is set synchronously)
    await backend.prompt(idle.id, { text: "please continue" })
    expect((await backend.getSession(idle.id)).title).toBe("Image CDN migration") // already titled: prompt leaves it
    const mid = await backend.messages(idle.id, 50)
    expect(mid.data.some((m: any) => m.type === "user")).toBe(true)
    // second prompt while running with delivery queue must enqueue, not deliver
    const deliveredBefore = events.filter((e) => e.type === "session.inbox.delivered").length
    await backend.prompt(idle.id, { text: "later", delivery: "queue" })
    expect(await backend.inbox(idle.id)).toHaveLength(1)
    expect(events.filter((e) => e.type === "session.inbox.delivered").length).toBe(deliveredBefore)
    const item = (await backend.inbox(idle.id))[0]!
    await backend.setInboxDelivery(idle.id, item.id, "steer")
    expect((await backend.inbox(idle.id))[0]!.delivery).toBe("steer")
    await backend.cancelInbox(idle.id, item.id)
    expect(await backend.inbox(idle.id)).toEqual([])
    await backend.interrupt(idle.id)
    expect((await backend.getSession(idle.id)).outcome).toBe("interrupted")

    // permission reply clears the seeded prompt and announces it
    const blocked = (await backend.listSessions()).find((s) => s.title === "Refund webhooks")!
    const per = (await backend.permissions(blocked.id))[0]!
    await backend.replyPermission(blocked.id, per.id, "once" as never)
    expect(await backend.permissions(blocked.id)).toEqual([])
    expect(events.some((e) => e.type === "permission.replied")).toBe(true)
    await expect(backend.replyForm()).resolves.toBeUndefined()
    await expect(backend.cancelForm()).resolves.toBeUndefined()
  })
})
