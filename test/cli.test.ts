import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI = join(import.meta.dir, "..", "bin", "hermes-canvas")
const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

describe("bin/hermes-canvas CLI", () => {
  test("--help prints usage and exits 0", async () => {
    const proc = Bun.spawn(["bun", CLI, "--help"], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(out).toContain("Usage: hermes-canvas")
  })

  test("unknown flags and invalid ports exit 2 cleanly", async () => {
    const badFlag = Bun.spawn(["bun", CLI, "--not-a-real-flag"], { stdout: "pipe", stderr: "pipe" })
    const flagErr = await new Response(badFlag.stderr).text()
    expect(await badFlag.exited).toBe(2)
    expect(flagErr).toContain("hermes-canvas:")

    for (const arg of ["--port=abc", "--port=70000", "--port=-1", "--port="]) {
      const badPort = Bun.spawn(["bun", CLI, arg], { stdout: "pipe", stderr: "pipe" })
      const portErr = await new Response(badPort.stderr).text()
      expect(await badPort.exited).toBe(2)
      expect(portErr).toContain("invalid port")
    }
  })

  test("--demo --port 0 boots server, serves config, and shuts down on kill", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-cli-home-"))
    const proc = Bun.spawn(["bun", CLI, "--demo", "--port", "0", "--home", home], {
      stdout: "pipe",
      stderr: "pipe",
    })
    cleanups.push(() => {
      try { proc.kill() } catch { /* ignore */ }
      try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    let out = ""
    let url = ""
    for (let i = 0; i < 40; i++) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(100).then(() => ({ done: false, value: undefined as Uint8Array | undefined })),
      ])
      if (chunk.value) out += dec.decode(chunk.value, { stream: true })
      const m = out.match(/http:\/\/localhost:(\d+)/)
      if (m) {
        url = m[0]
        break
      }
      if (chunk.done) break
    }
    try { reader.cancel() } catch { /* ignore */ }
    expect(url).toMatch(/^http:\/\/localhost:\d+$/)

    const cfg = await (await fetch(`${url}/canvas/config`)).json()
    expect(cfg).toMatchObject({ mode: "demo", connected: true, backend: "hermes" })

    proc.kill("SIGTERM")
    const code = await Promise.race([proc.exited, Bun.sleep(3000).then(() => -1)])
    expect(code).not.toBe(-1)
  })
})
