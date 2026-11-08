import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { makeHermesHome } from "./helpers"
import { type CanvasEvent, interruptSession, runningSessionIDs, startPrompt } from "../src/server/hermes"

// Prompt-stream lane (hermes.ts pumpPromptStream). server.test.ts covers the
// happy path over HTTP (fast mode) and hang+interrupt; this file drives
// startPrompt directly against fake-hermes for the branches that lane never
// hits: failing tool_result (session.tool.failed), malformed NDJSON lines,
// exit-without-result (finish via exit code), and failed result.

let savedMode: string | undefined

beforeAll(() => {
  savedMode = process.env.HERMES_FAKE_MODE
  makeHermesHome() // points HERMES_BIN at fake-hermes.ts
})

afterAll(() => {
  if (savedMode === undefined) delete process.env.HERMES_FAKE_MODE
  else process.env.HERMES_FAKE_MODE = savedMode
})

async function promptEvents(mode: string, id: string): Promise<CanvasEvent[]> {
  process.env.HERMES_FAKE_MODE = mode
  const events: CanvasEvent[] = []
  await startPrompt(id, `hello ${mode}`, { emit: (ev) => events.push(ev) })
  for (let i = 0; i < 100; i++) {
    if (events.some((e) => e.type === "session.execution.succeeded" || e.type === "session.execution.failed")) break
    await Bun.sleep(50)
  }
  // let pumpPromptStream's finally clear runningProcs before the next test
  for (let i = 0; i < 50 && runningSessionIDs().has(id); i++) await Bun.sleep(50)
  return events
}

describe("startPrompt stream branches", () => {
  test("a failing tool_result emits session.tool.failed, not success", async () => {
    const events = await promptEvents("errtool", "ses_new_1")
    const types = events.map((e) => e.type)
    expect(types).toContain("session.tool.failed")
    expect(types).not.toContain("session.tool.success")
    expect(types).toContain("session.execution.succeeded")
    const failed = events.find((e) => e.type === "session.tool.failed")!
    expect(failed.data.id).toBe("live_0") // no tool_call_id in errtool: falls back to live_0
    expect(String(failed.data.error)).toContain("disk full")
  })

  test("malformed NDJSON lines are skipped, not fatal", async () => {
    const events = await promptEvents("malformed", "ses_new_1")
    const types = events.map((e) => e.type)
    expect(types).toContain("session.text.delta")
    expect(types).toContain("session.tool.success")
    expect(types).toContain("session.execution.succeeded")
    expect(types).not.toContain("session.execution.failed")
  })

  test("exit without a result line finishes via the exit code", async () => {
    const events = await promptEvents("noresult", "ses_new_1")
    const types = events.map((e) => e.type)
    expect(types).toContain("session.text.ended")
    expect(types).toContain("session.step.ended")
    expect(types).toContain("session.execution.succeeded")
  })

  test("a non-zero result exit emits execution.failed", async () => {
    const events = await promptEvents("failresult", "ses_new_1")
    const types = events.map((e) => e.type)
    expect(types).toContain("session.execution.failed")
    expect(types).not.toContain("session.execution.succeeded")
  })

  test("duplicate prompt for a running session throws and leaves the first alone", async () => {
    process.env.HERMES_FAKE_MODE = "hang"
    const events: CanvasEvent[] = []
    await startPrompt("ses_new_1", "long task", { emit: (ev) => events.push(ev) })
    // pump is now blocked inside the fake's 30s sleep; whatever is still inert
    // in the module-level map, a second start must throw synchronously.
    expect(runningSessionIDs().has("ses_new_1")).toBe(true)
    await expect(startPrompt("ses_new_1", "again", { emit: () => {} })).rejects.toThrow("already running")
    expect(interruptSession("ses_new_1")).toBe(true)
    for (let i = 0; i < 50 && runningSessionIDs().has("ses_new_1"); i++) await Bun.sleep(50)
    process.env.HERMES_FAKE_MODE = "fast"
  })

  test("create mode spawns without --resume and emits session.created for the minted id", async () => {
    process.env.HERMES_FAKE_MODE = "create"
    const { createDraftSession } = await import("../src/server/hermes")
    const draft = createDraftSession("/repo/draft")
    const events: CanvasEvent[] = []
    await startPrompt(draft.id, "hello create", { emit: (ev) => events.push(ev) })
    for (let i = 0; i < 100; i++) {
      if (events.some((e) => e.type === "session.execution.succeeded" || e.type === "session.execution.failed")) break
      await Bun.sleep(50)
    }
    for (let i = 0; i < 50 && runningSessionIDs().has(draft.id); i++) await Bun.sleep(50)
    const types = events.map((e) => e.type)
    expect(types).toContain("session.created")
    const created = events.find((e) => e.type === "session.created")!
    expect(created.data.sessionID).toBe("local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    expect(created.data.draftId).toBe(draft.id)
    expect(types).toContain("session.execution.succeeded")
    // Subsequent streaming events ride the real id, not the draft.
    const delta = events.find((e) => e.type === "session.text.delta")
    expect(delta?.data.sessionID).toBe("local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    process.env.HERMES_FAKE_MODE = "fast"
  })

  test("failed execution surfaces stderr error text", async () => {
    process.env.HERMES_FAKE_MODE = "notfound"
    const events: CanvasEvent[] = []
    await startPrompt("ses_new_1", "hello", { emit: (ev) => events.push(ev) })
    for (let i = 0; i < 100; i++) {
      if (events.some((e) => e.type === "session.execution.succeeded" || e.type === "session.execution.failed")) break
      await Bun.sleep(50)
    }
    for (let i = 0; i < 50 && runningSessionIDs().has("ses_new_1"); i++) await Bun.sleep(50)
    const failed = events.find((e) => e.type === "session.execution.failed")!
    expect(failed).toBeTruthy()
    expect(String(failed.data.error ?? "")).toContain("No session found matching")
    process.env.HERMES_FAKE_MODE = "fast"
  })

  test("a throwing emit kills the prompt and finishes failed (pump catch)", async () => {
    process.env.HERMES_FAKE_MODE = "fast"
    const events: CanvasEvent[] = []
    let emits = 0
    await startPrompt("ses_new_1", "hello", {
      emit: (ev) => {
        emits++
        if (emits === 2) throw new Error("emit blew up") // 1st is execution.started; 2nd is the first pump emit
        events.push(ev)
      },
    })
    for (let i = 0; i < 100; i++) {
      if (events.some((e) => e.type === "session.execution.failed")) break
      await Bun.sleep(50)
    }
    for (let i = 0; i < 50 && runningSessionIDs().has("ses_new_1"); i++) await Bun.sleep(50)
    const types = events.map((e) => e.type)
    expect(types).toContain("session.execution.failed") // catch finishes failed
    expect(types).not.toContain("session.execution.succeeded")
    expect(types).not.toContain("session.text.delta") // died before any delta
    expect(runningSessionIDs().has("ses_new_1")).toBe(false) // running cleared
    process.env.HERMES_FAKE_MODE = "fast"
  })
})
