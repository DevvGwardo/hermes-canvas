import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeHermesHome } from "./helpers"
import {
  type CanvasEvent,
  defaultModel,
  listModels,
  projectIDFor,
  sessionMessages,
  sessionYoloState,
  setAutoApproveAll,
  startWatcher,
} from "../src/server/hermes"

// T35: the DB-facing half of the session-store adapter. hermes.test.ts owns
// the pure row mapping; hermes-backend.test.ts owns the HTTP client. This
// file drives the store functions themselves against a seeded temp state.db.

let home: string
let savedHome: string

beforeAll(() => {
  savedHome = process.env.HERMES_HOME ?? ""
  home = makeHermesHome() // points HERMES_* env at a seeded temp home
})

afterAll(() => {
  process.env.HERMES_HOME = savedHome
})

describe("sessionMessages paging", () => {
  test("a page starting mid-turn extends back to the turn start", () => {
    // limit=1 lands on the tool row whose assistant turn is older.
    const { data, cursor } = sessionMessages("ses_new_1", 1)
    expect(data.map((m: any) => m.type)).toEqual(["assistant", "user"]) // tool folded, not orphaned
    const tool = data[0].content.find((p: any) => p.type === "tool")
    // The fixture envelope embeds a raw newline, so the parse fails and the
    // raw content passes through (prettyToolText's unwrap is pinned in T34).
    expect(tool.state.content[0].text).toBe('{"output":"a\nb","exit_code":0}')
    expect(cursor?.next).toBe("1") // next pages over raw row ids
  })

  test("a lone trailing tool row stops extending and wraps itself", () => {
    const raw = new Database(process.env.HERMES_CANVAS_DB!)
    raw.exec(
      `INSERT INTO sessions (id, source, started_at, cwd) VALUES ('ses_lone_tool', 'cli', ${Date.now() / 1000}, '/repo/lone')`,
    )
    raw.exec(
      `INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES ('ses_lone_tool', 'tool', 'x', 'probe', ${Date.now() / 1000})`,
    )
    const row = raw.query("SELECT MAX(id) m FROM messages").get() as { m: number }
    raw.close()

    const { data } = sessionMessages("ses_lone_tool", 1)
    expect(data).toHaveLength(1)
    expect(data[0].id).toBe(`hma_t_${row.m}`) // no older rows: break, orphan wrapper
    expect(data[0].content[0]).toMatchObject({ id: `hm_${row.m}`, name: "probe" })
  })
})

describe("startWatcher", () => {
  test("new sessions announce created; external turns debounce to succeeded", () => {
    jest.useFakeTimers()
    const events: CanvasEvent[] = []
    const stopW = startWatcher((ev) => events.push(ev), 1000)
    try {
      expect(events).toHaveLength(0) // the synchronous prime is silent

      const raw = new Database(process.env.HERMES_CANVAS_DB!)
      raw.exec(
        `INSERT INTO sessions (id, source, started_at, cwd, title) VALUES ('ses_fresh', 'cli', ${Date.now() / 1000}, '/repo/fresh', 'Fresh')`,
      )
      jest.advanceTimersByTime(1000) // poll 1: snapshot sees the new session
      expect(events.map((e) => e.type)).toEqual(["session.created"])
      expect(events[0].data).toMatchObject({
        sessionID: "ses_fresh",
        title: "Fresh",
        agent: "cli",
        projectID: projectIDFor("/repo/fresh"),
      })

      events.length = 0
      raw.exec(
        `INSERT INTO messages (session_id, role, content, timestamp) VALUES ('ses_fresh', 'user', 'hi', ${Date.now() / 1000})`,
      )
      jest.advanceTimersByTime(1000) // poll 2: external message -> started + debounce
      expect(events.map((e) => e.type)).toEqual(["session.execution.started"])

      jest.advanceTimersByTime(1000) // poll 3: nothing fresh, timer still pending
      raw.exec(
        `INSERT INTO messages (session_id, role, content, timestamp) VALUES ('ses_fresh', 'user', 'again', ${Date.now() / 1000})`,
      )
      jest.advanceTimersByTime(1000) // poll 4: re-seen in-window -> debounce resets, no second start
      expect(events.map((e) => e.type)).toEqual(["session.execution.started"])

      jest.advanceTimersByTime(4500) // the reset window elapses exactly once
      expect(events.map((e) => e.type)).toEqual(["session.execution.started", "session.execution.succeeded"])
      raw.close()
    } finally {
      stopW() // clears the interval and any pending debounce
      jest.useRealTimers()
    }
  })
})

describe("config.yaml and auto-approve seams", () => {
  test("defaultModel falls back to custom for a slashless default; a missing file is undefined", () => {
    const cfgHome = mkdtempSync(join(tmpdir(), "hermes-cfg-"))
    try {
      process.env.HERMES_HOME = cfgHome
      expect(defaultModel()).toBeUndefined() // no config.yaml: catch -> undefined
      expect(listModels().length).toBeGreaterThan(0) // DB models only; config scan catches the missing file
      writeFileSync(
        join(cfgHome, "config.yaml"),
        "model:\n  default: plainmodel\ncustom_providers:\n  - name: cfgprov\n    models:\n      cfg-only-9: {}\n",
      )
      expect(defaultModel()).toMatchObject({ id: "plainmodel", providerID: "custom", name: "plainmodel" })
      expect(listModels()).toContainEqual({ id: "cfg-only-9", providerID: "cfgprov", name: "cfgprov/cfg-only-9" })
    } finally {
      process.env.HERMES_HOME = home
    }
  })

  test("setAutoApproveAll overrides per-session yolo state", () => {
    expect(sessionYoloState("ses_x")).toBe(false)
    setAutoApproveAll(true)
    try {
      expect(sessionYoloState("ses_x")).toBe(true)
    } finally {
      setAutoApproveAll(false)
    }
    expect(sessionYoloState("ses_x")).toBe(false)
  })
})
