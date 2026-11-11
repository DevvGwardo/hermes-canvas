import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { makeHermesHome } from "./helpers"
import { type CanvasEvent, runningSessionIDs, startPrompt } from "../src/server/hermes"

// Launcher-probe lane (hermes.ts resolveChatLauncher probe branch + runRaw).
// With HERMES_BIN unset, the probe shells `hermes --version` for the install
// dir, then tries candidate pythons for `import hermes_cli.main`. This file
// shims both sides hermetically (.cmd on Windows, chmod +x shell scripts on POSIX)
// so no real hermes/python is ever spawned. Own file: the module-level
// chatLauncher caches on first probe, so this scenario must not share a
// process with the HERMES_BIN-set prompt tests.

const win32 = process.platform === "win32"

let tmp: string
let site: string
let savedPath: string | undefined
let savedBin: string | undefined
let savedPython: string | undefined
let savedSite: string | undefined

function writeShims(dir: string, installSite: string, failVersion = false) {
  if (win32) {
    writeFileSync(
      join(dir, "hermes.cmd"),
      failVersion
        ? "@echo off\r\nexit /b 1\r\n"
        : `@echo off\r\necho Hermes Agent v0 TEST\r\necho Install directory: ${installSite}\r\nexit /b 0\r\n`,
    )
    const py = join(dir, "fakepy.cmd")
    writeFileSync(
      py,
      [
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
      ].join("\r\n"),
    )
    return py
  }

  const hermesSh = join(dir, "hermes")
  writeFileSync(
    hermesSh,
    failVersion
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\necho "Hermes Agent v0 TEST"\necho "Install directory: ${installSite}"\nexit 0\n`,
  )
  chmodSync(hermesSh, 0o755)
  const py = join(dir, "fakepy")
  writeFileSync(
    py,
    [
      "#!/bin/sh",
      'case "$*" in',
      "  *hermes_cli.main*)",
      "    echo ok",
      '    printf \'%s\\n\' \'{"type":"text","text":"managed-chat"}\'',
      '    printf \'%s\\n\' \'{"type":"result","session_id":"test","exit_code":0}\'',
      "    exit 0",
      "    ;;",
      "esac",
      "echo ok",
      "exit 0",
      "",
    ].join("\n"),
  )
  chmodSync(py, 0o755)
  return py
}

beforeAll(() => {
  savedPath = process.env.PATH
  savedBin = process.env.HERMES_BIN
  savedPython = process.env.HERMES_PYTHON
  savedSite = process.env.HERMES_SITE_PACKAGES
  makeHermesHome()
  tmp = mkdtempSync(join(tmpdir(), "hermes-launcher-"))
  site = join(tmp, "fake-site")
  mkdirSync(site, { recursive: true })
  const py = writeShims(tmp, site)
  delete process.env.HERMES_BIN
  delete process.env.HERMES_SITE_PACKAGES
  process.env.HERMES_PYTHON = py
  process.env.PATH = `${tmp}${delimiter}${savedPath ?? ""}`
})

afterAll(() => {
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  if (savedBin === undefined) delete process.env.HERMES_BIN
  else process.env.HERMES_BIN = savedBin
  if (savedPython === undefined) delete process.env.HERMES_PYTHON
  else process.env.HERMES_PYTHON = savedPython
  if (savedSite === undefined) delete process.env.HERMES_SITE_PACKAGES
  else process.env.HERMES_SITE_PACKAGES = savedSite
  process.env.HERMES_FAKE_MODE = "fast"
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe("launcher probe (HERMES_BIN unset)", () => {
  test("selects the managed python when the import check passes", async () => {
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
    // the fake python emit "managed-chat"; plain ["hermes", ...] emits no NDJSON.
    expect(delta?.data.delta).toBe("managed-chat")
  })

  test("HERMES_SITE_PACKAGES bypasses hermes --version probe", async () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "hermes-launcher-site-"))
    const prevPath = process.env.PATH
    try {
      const py2 = writeShims(tmp2, site, true) // hermes --version fails here
      process.env.HERMES_SITE_PACKAGES = site
      process.env.HERMES_PYTHON = py2
      process.env.PATH = `${tmp2}${delimiter}${savedPath ?? ""}`
      const events: CanvasEvent[] = []
      await startPrompt("ses_new_1", "hello site", { emit: (ev) => events.push(ev) })
      for (let i = 0; i < 100; i++) {
        if (events.some((e) => e.type === "session.execution.succeeded" || e.type === "session.execution.failed")) break
        await Bun.sleep(50)
      }
      for (let i = 0; i < 50 && runningSessionIDs().has("ses_new_1"); i++) await Bun.sleep(50)
      const delta = events.find((e) => e.type === "session.text.delta")
      expect(delta?.data.delta).toBe("managed-chat")
    } finally {
      delete process.env.HERMES_SITE_PACKAGES
      process.env.HERMES_PYTHON = join(tmp, win32 ? "fakepy.cmd" : "fakepy")
      process.env.PATH = prevPath
      try { rmSync(tmp2, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})
