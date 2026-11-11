import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeHermesHome } from "./helpers"
import { type CanvasEvent, interruptSession, runningSessionIDs, startPrompt, waitForPromptExit } from "../src/server/hermes"

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

  test("throwing on 1st emit kills proc and cleans runningSessionIDs", async () => {
    process.env.HERMES_FAKE_MODE = "hang"
    try {
      await expect(
        startPrompt("ses_throw_1", "boom", {
          emit: () => {
            throw new Error("listener down")
          },
        }),
      ).rejects.toThrow("listener down")
      expect(runningSessionIDs().has("ses_throw_1")).toBe(false)
    } finally {
      process.env.HERMES_FAKE_MODE = "fast"
    }
  })

  test("multi-step ordinals, FIFO nameless tool IDs, EOF without newline, and large stderr", async () => {
    const savedBin = process.env.HERMES_BIN
    const tmp = mkdtempSync(join(tmpdir(), "hermes-stream-edge-"))
    const script = join(tmp, "edge-hermes.ts")
    writeFileSync(
      script,
      [
        'process.stderr.write("E".repeat(160_000));',
        'const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\\n");',
        'out({ type: "text", text: "step0" });',
        'out({ type: "tool_use", name: "terminal", input: { cmd: "a" } });',
        'out({ type: "tool_use", name: "terminal", input: { cmd: "b" } });',
        'out({ type: "tool_result", name: "terminal", output: "out-a", is_error: false });',
        'out({ type: "tool_result", name: "terminal", output: "out-b", is_error: false });',
        'out({ type: "text", text: "step1" });',
        'process.stdout.write(JSON.stringify({ type: "text", text: "tail-eof" }));',
        "process.exit(0);",
        "",
      ].join("\n"),
    )
    process.env.HERMES_BIN = `bun ${script}`
    try {
      const events: CanvasEvent[] = []
      await startPrompt("ses_edge_1", "hi", { emit: (ev) => events.push(ev) })
      await waitForPromptExit("ses_edge_1")

      const started = events.filter((e) => e.type === "session.text.started")
      expect(started.map((e) => e.data.ordinal)).toEqual([0, 1])

      const deltas = events.filter((e) => e.type === "session.text.delta").map((e) => e.data.delta)
      expect(deltas).toEqual(["step0", "step1", "tail-eof"])

      const calledIDs = events.filter((e) => e.type === "session.tool.called").map((e) => e.data.id)
      const successIDs = events.filter((e) => e.type === "session.tool.success").map((e) => e.data.id)
      expect(calledIDs).toEqual(["live_0", "live_1"])
      expect(successIDs).toEqual(["live_0", "live_1"])
      expect(events.map((e) => e.type)).toContain("session.execution.succeeded")
    } finally {
      if (savedBin === undefined) delete process.env.HERMES_BIN
      else process.env.HERMES_BIN = savedBin
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  test("missing cwd falls back cleanly without spawn ENOENT", async () => {
    const savedPromptCwd = process.env.HERMES_CANVAS_PROMPT_CWD
    delete process.env.HERMES_CANVAS_PROMPT_CWD
    try {
      const events: CanvasEvent[] = []
      await startPrompt("ses_cwd_1", "hi", {
        cwd: join(tmpdir(), "definitely-does-not-exist-hermes-cwd"),
        emit: (ev) => events.push(ev),
      })
      await waitForPromptExit("ses_cwd_1")
      expect(events.map((e) => e.type)).toContain("session.execution.succeeded")
    } finally {
      if (savedPromptCwd === undefined) delete process.env.HERMES_CANVAS_PROMPT_CWD
      else process.env.HERMES_CANVAS_PROMPT_CWD = savedPromptCwd
    }
  })

  test("interrupt prevents late execution.failed and double interrupt returns false", async () => {
    process.env.HERMES_FAKE_MODE = "hang"
    const events: CanvasEvent[] = []
    try {
      await startPrompt("ses_int_1", "long", { emit: (ev) => events.push(ev) })
      expect(interruptSession("ses_int_1")).toBe(true)
      expect(interruptSession("ses_int_1")).toBe(false)
      expect(runningSessionIDs().has("ses_int_1")).toBe(false)
      await waitForPromptExit("ses_int_1")
      expect(events.map((e) => e.type)).not.toContain("session.execution.failed")
      expect(events.map((e) => e.type)).not.toContain("session.execution.succeeded")
    } finally {
      process.env.HERMES_FAKE_MODE = "fast"
    }
  })

  test("concurrent startPrompt during launcher probe rejects as already running", async () => {
    const savedBin = process.env.HERMES_BIN
    const savedSite = process.env.HERMES_SITE_PACKAGES
    const savedPy = process.env.HERMES_PYTHON
    const tmp = mkdtempSync(join(tmpdir(), "hermes-race-probe-"))
    const slowBin = join(tmp, "slow-launcher.ts")
    writeFileSync(
      slowBin,
      [
        "await Bun.sleep(150);",
        'if (process.argv.includes("-c")) { console.log("ok"); process.exit(0); }',
        'console.log(JSON.stringify({ type: "result", exit_code: 0 }));',
        "",
      ].join("\n"),
    )
    // Bypass PATH shims by making a script wrapper on HERMES_BIN unset + bun script? Note spawn calls [py, ...], so wrap bun in a tiny executable!
    const win32 = process.platform === "win32"
    const pyShim = join(tmp, win32 ? "slowpy.cmd" : "slowpy")
    writeFileSync(
      pyShim,
      win32
        ? `@echo off\r\nbun "${slowBin}" %*\r\n`
        : `#!/bin/sh\nexec bun "${slowBin}" "$@"\n`,
    )
    if (!win32) {
      const { chmodSync } = await import("node:fs")
      chmodSync(pyShim, 0o755)
    }
    delete process.env.HERMES_BIN
    process.env.HERMES_SITE_PACKAGES = tmp
    process.env.HERMES_PYTHON = pyShim
    try {
      const p1 = startPrompt("ses_race_1", "one", { emit: () => {} })
      const p2 = startPrompt("ses_race_1", "two", { emit: () => {} })
      await expect(p2).rejects.toThrow("already running")
      await p1
      await waitForPromptExit("ses_race_1")
    } finally {
      if (savedBin === undefined) delete process.env.HERMES_BIN
      else process.env.HERMES_BIN = savedBin
      if (savedSite === undefined) delete process.env.HERMES_SITE_PACKAGES
      else process.env.HERMES_SITE_PACKAGES = savedSite
      if (savedPy === undefined) delete process.env.HERMES_PYTHON
      else process.env.HERMES_PYTHON = savedPy
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})
