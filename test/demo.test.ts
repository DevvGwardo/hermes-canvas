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
  })
})
