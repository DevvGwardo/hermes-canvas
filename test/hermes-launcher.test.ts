import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeHermesHome } from "./helpers"
import { type CanvasEvent, runningSessionIDs, startPrompt } from "../src/server/hermes"

// Launcher-probe lane (hermes.ts resolveChatLauncher probe branch + runRaw).
// With HERMES_BIN unset, the probe shells `hermes --version` for the install
// dir, then tries candidate pythons for `import hermes_cli.main`. This file
// shims both sides hermetically (.cmd via PATH, like the real exe) so no real
// hermes/python is ever spawned: fake --version reports a fake Install dir,
// HERMES_PYTHON points at a fake python that answers the import check and,
// on managed-chat invocation, emits NDJSON. Own file: the module-level
// chatLauncher caches on first probe, so this scenario must not share a
// process with the HERMES_BIN-set prompt tests.

// .cmd shims + ";" PATH separators are Windows-only; CI also runs Linux.
const win32 = process.platform === "win32"

let tmp: string
let savedPath: string | undefined
let savedBin: string | undefined
let savedPython: string | undefined

beforeAll(() => {
  if (!win32) return
  savedPath = process.env.PATH
  savedBin = process.env.HERMES_BIN
  savedPython = process.env.HERMES_PYTHON
  const home = makeHermesHome() // still points HERMES_BIN at fake-hermes.ts; we unset it below
  void home
  tmp = mkdtempSync(join(tmpdir(), "hermes-launcher-"))
  const site = join(tmp, "fake-site")
  mkdirSync(site, { recursive: true })
  writeFileSync(join(tmp, "hermes.cmd"), "@echo off\r\necho Hermes Agent v0 TEST\r\necho Install directory: " + site + "\r\nexit /b 0\r\n")
  writeFileSync(join(tmp, "fakepy.cmd"), [
    "@echo off",
    'echo %* | findstr /C:"hermes_cli.main" >nul',
    "if %ERRORLEVEL%==0 (",
    "  echo ok",
    '  echo {"type":"text","text":"managed-chat"}',
    '  echo {"type":"result","session_id":"test","exit_code":0}',
    "  exit /b 0",
    ")",
    "echo ok",
    "exit /b 0",
    "",
  ].join("\r\n"))
  delete process.env.HERMES_BIN
  process.env.HERMES_PYTHON = join(tmp, "fakepy.cmd")
  process.env.PATH = tmp + ";" + (savedPath ?? process.env.PATH)
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

describe("launcher probe (HERMES_BIN unset)", () => {
  test.skipIf(!win32)("selects the managed python when the import check passes", async () => {
    const events: CanvasEvent[] = []
    await startPrompt("ses_new_1", "hello launcher", { emit: (ev) => events.push(ev) })
    for (let i = 0; i < 100; i++) {
      if (events.some((e) => e.type === "session.execution.succeeded" || e.type === "session.execution.failed")) break
      await Bun.sleep(50)
    }
    for (let i = 0; i < 50 && runningSessionIDs().has("ses_new_1"); i++) await Bun.sleep(50)
    const types = events.map((e) => e.type)
    expect(types).toContain("session.execution.succeeded")
    const delta = events.find((e) => e.type === "session.text.delta")
    // Only the managed argv ([fakepy, -m, hermes_cli.main, chat ...]) makes
    // the fake python emit "managed-chat"; plain ["hermes", ...] would run
    // the fake hermes.cmd which emits no NDJSON.
    expect(delta?.data.delta).toBe("managed-chat")
  })
})
