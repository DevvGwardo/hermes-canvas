import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeHermesHome } from "./helpers"
import { type CanvasEvent, runningSessionIDs, startPrompt } from "../src/server/hermes"

// Launcher fallback lane: HERMES_BIN unset, every candidate python fails
// (the explicit one exits 1, the rest are missing exes → per-candidate
// catch), so the probe returns plain ["hermes"]. Own file: chatLauncher
// caches on first probe, so this fallback scenario needs its own process
// from the managed-selection file. The fake hermes.cmd answers
// --version with a fake Install dir, and plain chat with plain-chat NDJSON.

// .cmd shims + ";" PATH separators are Windows-only; CI also runs Linux.
const win32 = process.platform === "win32"

let savedPath: string | undefined
let savedBin: string | undefined
let savedPython: string | undefined
let tmp: string

beforeAll(() => {
  if (!win32) return
  savedPath = process.env.PATH
  savedBin = process.env.HERMES_BIN
  savedPython = process.env.HERMES_PYTHON
  makeHermesHome()
  tmp = mkdtempSync(join(tmpdir(), "hermes-launcher-fallback-"))
  const site = join(tmp, "fake-site")
  mkdirSync(site, { recursive: true })
  writeFileSync(join(tmp, "hermes.cmd"), [
    "@echo off",
    'if "%~1"=="--version" (',
    "  echo Hermes Agent v0 TEST",
    "  echo Install directory: " + site,
    "  exit /b 0",
    ")",
    'echo {"type":"text","text":"plain-chat"}',
    'echo {"type":"result","session_id":"test","exit_code":0}',
    "exit /b 0",
    "",
  ].join("\r\n"))
  writeFileSync(join(tmp, "failing.cmd"), "@echo off\r\necho nope\r\nexit /b 1\r\n")
  delete process.env.HERMES_BIN
  process.env.HERMES_PYTHON = join(tmp, "failing.cmd")
  // Keep System32 so .cmd shims can still launch cmd.exe, but no WindowsApps
  // python3/python on PATH: those candidates ENOENT into the per-candidate catch.
  const sys32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32")
  process.env.PATH = tmp + ";" + sys32
})

afterAll(() => {
  if (!win32) return
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  if (savedBin === undefined) delete process.env.HERMES_BIN
  else process.env.HERMES_BIN = savedBin
  if (savedPython === undefined) delete process.env.HERMES_PYTHON
  else process.env.HERMES_PYTHON = savedPython
  process.env.HERMES_FAKE_MODE = "fast"
})

describe("launcher fallback (HERMES_BIN unset, all pythons fail)", () => {
  test.skipIf(!win32)("returns plain [hermes] when no managed python checks out", async () => {
    const events: CanvasEvent[] = []
    await startPrompt("ses_new_1", "hello plain", { emit: (ev) => events.push(ev) })
    for (let i = 0; i < 100; i++) {
      if (events.some((e) => e.type === "session.execution.succeeded" || e.type === "session.execution.failed")) break
      await Bun.sleep(50)
    }
    for (let i = 0; i < 50 && runningSessionIDs().has("ses_new_1"); i++) await Bun.sleep(50)
    const types = events.map((e) => e.type)
    expect(types).toContain("session.execution.succeeded")
    const delta = events.find((e) => e.type === "session.text.delta")
    // Plain argv runs the fake hermes.cmd chat, which emits plain-chat.
    expect(delta?.data.delta).toBe("plain-chat")
  })
})
