import { describe, expect, test } from "bun:test"
import type { Backend } from "../src/app/backend"
import { REVIEW_WINDOW, Store } from "../src/app/store"
import type { Session } from "../src/app/types"

const now = 1_800_000_000_000
const H = 3600_000

function session(id: string, time: Partial<Session["time"]>, extra: Partial<Session> = {}): Session {
  return {
    id,
    projectID: "p",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now - 10 * H, updated: now - H, ...time },
    location: { directory: "/x" },
    ...extra,
  }
}

const viewedCalls: Array<[string, number]> = []
const backend = { kind: "demo", markViewed: async (id: string, at: number) => void viewedCalls.push([id, at]) } as unknown as Backend

function store(...list: Session[]) {
  const s = new Store(backend)
  for (const x of list) s.sessions.set(x.id, x)
  ;(s as any).rebuildChildren()
  return s
}

describe("status", () => {
  test("finished and not opened since → review; opened → done", () => {
    const s = store(
      session("a", { idle: now - H, viewed: now - 2 * H }, { outcome: "succeeded" }),
      session("b", { idle: now - H, viewed: now - H }, { outcome: "succeeded" }),
    )
    expect(s.status("a", now)).toBe("review")
    expect(s.status("b", now)).toBe("done")
  })

  test("review expires after the window", () => {
    const s = store(session("a", { idle: now - REVIEW_WINDOW - 1 }, { outcome: "succeeded" }))
    expect(s.status("a", now)).toBe("done")
  })

  test("urgency order: needs you > working > failed", () => {
    const s = store(session("a", { idle: now - H }, { outcome: "failed" }))
    expect(s.status("a", now)).toBe("failed")
    s.running.add("a")
    expect(s.status("a", now)).toBe("working")
    s.permissions.set("a", [{ id: "per_1", sessionID: "a", action: "shell", resources: [] }])
    expect(s.status("a", now)).toBe("needs-you")
  })

  test("a parent is working or blocked when its subagent is", () => {
    const s = store(session("p1", { idle: now - H, viewed: now }), session("c1", {}, { parentID: "p1" }))
    s.running.add("c1")
    expect(s.status("p1", now)).toBe("working")
    s.forms.set("c1", [{ id: "frm_1", sessionID: "c1", title: "Pick one", fields: [] as any }])
    expect(s.status("p1", now)).toBe("needs-you")
  })

  test("counts: fresh failures are to review, old ones aren't news", () => {
    const s = store(
      session("a", { idle: now - H }, { outcome: "failed" }),
      session("b", { idle: now - 100 * H }, { outcome: "failed" }),
      session("c", { idle: now - H }, { outcome: "succeeded" }),
      session("d", { idle: now - H }, { outcome: "interrupted" }),
    )
    const c = s.statusCounts(now)
    expect(c.failed).toBe(1)
    expect(c.review).toBe(1)
    expect(c.stopped).toBe(1)
    expect(c.done).toBe(1)
    expect(s.inFilter("a", "review", now)).toBe(true)
    expect(s.inFilter("b", "review", now)).toBe(false)
  })

  test("markViewed clears review and tells the server", () => {
    const s = store(session("a", { idle: now - H }, { outcome: "succeeded" }))
    ;(s as any).touchParent = () => {}
    s.markViewed("a")
    expect(s.status("a")).toBe("done")
    expect(viewedCalls.at(-1)![0]).toBe("a")
    expect(viewedCalls.at(-1)![1]).toBeGreaterThanOrEqual(now - H)
  })
})
