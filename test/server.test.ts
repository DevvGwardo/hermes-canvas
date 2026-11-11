import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { makeHermesHome } from "./helpers"
import { isLoopbackHost, startServer } from "../src/server/server"

const home = makeHermesHome()
process.env.HERMES_FAKE_MODE = "fast"

const { server, stop } = await startServer({
  port: 0,
  hostname: "127.0.0.1",
  demo: false,
  dev: false,
  quiet: true,
})
const base = `http://127.0.0.1:${server.port}`

afterAll(() => stop())

const j = (r: Response) => r.json()

describe("hermes api", () => {
  test("config reports the hermes backend without secrets", async () => {
    const cfg = await j(await fetch(`${base}/canvas/config`))
    expect(cfg).toMatchObject({ mode: "live", backend: "hermes", connected: true })
    expect(cfg.userHome).toBe(homedir())
    expect(JSON.stringify(cfg)).not.toContain("secret")
  })

  test("serves the app", async () => {
    const html = await (await fetch(base)).text()
    expect(html).toContain("<title>Hermes Canvas</title>")
  })

  test("lists sessions newest-first, skipping archived", async () => {
    const page = await j(await fetch(`${base}/api/hermes/session?limit=10`))
    const ids = page.data.map((s: any) => s.id)
    expect(ids).toEqual(["ses_new_1", "ses_old_1"])
    expect(page.data[0]).toMatchObject({
      projectID: expect.any(String),
      title: "Alpha session",
      model: { id: "deepseek-v4.1-flash", providerID: "custom" },
    })
    expect(page.data[0].location.directory).toBe("/repo/alpha")
  })

  test("projects group by directory", async () => {
    const projects = await j(await fetch(`${base}/api/hermes/project`))
    const dirs = projects.map((p: any) => p.canonical).sort()
    expect(dirs).toEqual(["/repo/alpha", "/repo/beta"])
  })

  test("messages page newest-first with cursor", async () => {
    const p1 = await j(await fetch(`${base}/api/hermes/session/ses_new_1/message?limit=2`))
    // limit applies to raw rows; the tool row folds into its assistant turn.
    expect(p1.data.map((m: any) => m.type)).toEqual(["assistant"])
    expect(p1.cursor?.next).toBeTruthy()
    const p2 = await j(await fetch(`${base}/api/hermes/session/ses_new_1/message?limit=2&cursor=${p1.cursor.next}`))
    expect(p2.data.map((m: any) => m.type)).toEqual(["user"])
    // The assistant turn carries its folded tool call.
    const tools = p1.data[0].content.filter((c: any) => c.type === "tool")
    expect(tools).toHaveLength(1)
    expect(tools[0].state.content[0].text).toContain("a\nb")
  })

  test("search finds sessions by title", async () => {
    const page = await j(await fetch(`${base}/api/hermes/session?search=Beta`))
    expect(page.data.map((s: any) => s.id)).toEqual(["ses_old_1"])
  })

  test("models come from the store plus config", async () => {
    const models = await j(await fetch(`${base}/api/hermes/model`))
    const names = models.map((m: any) => m.name)
    expect(names).toContain("custom/deepseek-v4.1-flash")
    expect(names).toContain("google/gemma-4-12b")
    const def = await j(await fetch(`${base}/api/hermes/model/default`))
    expect(def).toMatchObject({ id: "deepseek-v4.1-flash", providerID: "custom" })
  })

  test("unknown session is 404", async () => {
    const res = await fetch(`${base}/api/hermes/session/nope`)
    expect(res.status).toBe(404)
  })

  test("queues are empty; replies are accepted", async () => {
    for (const q of ["permission", "inbox", "form"]) {
      expect(await j(await fetch(`${base}/api/hermes/session/ses_new_1/${q}`))).toEqual([])
    }
    const res = await fetch(`${base}/api/hermes/session/ses_new_1/permission/x/reply`, { method: "POST", body: "{}" })
    expect(res.status).toBe(200)
  })

  test("view marks persist to the sidecar file", async () => {
    const res = await fetch(`${base}/api/hermes/session/ses_old_1/view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idle: 123 }),
    })
    expect(res.status).toBe(200)
    const page = await j(await fetch(`${base}/api/hermes/session?limit=10`))
    const old = page.data.find((s: any) => s.id === "ses_old_1")
    expect(old.time.viewed).toBeGreaterThanOrEqual(123)
  })

  test("prompt streams canvas events and completes", async () => {
    // Open the SSE feed and collect events for a few seconds.
    const ctrl = new AbortController()
    const stream = await fetch(`${base}/api/hermes/event`, { signal: ctrl.signal })
    const reader = stream.body!.getReader()
    const seen: string[] = []
    const collect = (async () => {
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                seen.push(JSON.parse(line.slice(6)).type)
              } catch { /* ignore */ }
            }
          }
        }
      }
    })()

    const res = await fetch(`${base}/api/hermes/session/ses_old_1/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping" }),
    })
    expect(res.status).toBe(200)
    const active = await j(await fetch(`${base}/api/hermes/session/active`))
    expect(active.ses_old_1?.type).toBe("running")

    // Wait for completion (fake exits immediately; poll the SSE captures).
    for (let i = 0; i < 100 && !seen.includes("session.execution.succeeded"); i++) {
      await Bun.sleep(100)
    }
    ctrl.abort()
    await collect.catch(() => {})
    for (const t of [
      "server.connected",
      "session.execution.started",
      "session.text.started",
      "session.text.delta",
      "session.tool.called",
      "session.tool.success",
      "session.execution.succeeded",
    ]) {
      expect(seen).toContain(t)
    }
  })

  test("interrupt stops a hanging prompt", async () => {
    process.env.HERMES_FAKE_MODE = "hang"
    const ctrl = new AbortController()
    const stream = await fetch(`${base}/api/hermes/event`, { signal: ctrl.signal })
    const reader = stream.body!.getReader()
    const seen: Array<{ type: string; data: any }> = []
    const collect = (async () => {
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) {
              try { seen.push(JSON.parse(line.slice(6))) } catch { /* ignore */ }
            }
          }
        }
      }
    })()

    try {
      const res = await fetch(`${base}/api/hermes/session/ses_old_1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "long task" }),
      })
      expect(res.status).toBe(200)
      for (let i = 0; i < 40; i++) {
        const a = await j(await fetch(`${base}/api/hermes/session/active`))
        if (a.ses_old_1?.type === "running") break
        await Bun.sleep(25)
      }
      const stopRes = await j(
        await fetch(`${base}/api/hermes/session/ses_old_1/interrupt`, { method: "POST" }),
      )
      expect(stopRes.stopped).toBe(true)
      const active = await j(await fetch(`${base}/api/hermes/session/active`))
      expect(active.ses_old_1).toBeUndefined()
      for (let i = 0; i < 40 && !seen.some((e) => e.type === "session.execution.interrupted"); i++) {
        await Bun.sleep(25)
      }
      await Bun.sleep(50)
      const types = seen.map((e) => e.type)
      expect(types).toContain("session.execution.interrupted")
      expect(types).not.toContain("session.execution.failed")
    } finally {
      ctrl.abort()
      await collect.catch(() => {})
      process.env.HERMES_FAKE_MODE = "fast"
    }
  })

  test("rename goes through the hermes CLI", async () => {
    const res = await fetch(`${base}/api/hermes/session/ses_old_1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed beta" }),
    })
    expect(res.status).toBe(200)
  })

  test("create inserts a session row", async () => {
    const s = await j(
      await fetch(`${base}/api/hermes/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ location: { directory: home } }),
      }),
    )
    expect(s.id).toMatch(/_\w{8}$/)
    const db = new Database(join(home, "state.db"), { readonly: true })
    const row = db.query("SELECT title, source FROM sessions WHERE id = ?").get(s.id) as any
    db.close()
    expect(row).toMatchObject({ source: "canvas" })
  })

  test("rejects cross-site requests", async () => {
    const a = await fetch(`${base}/api/hermes/session`, { method: "POST", headers: { origin: "https://evil.example" } })
    const b = await fetch(`${base}/api/hermes/session`, { headers: { "sec-fetch-site": "cross-site" } })
    expect(a.status).toBe(403)
    expect(b.status).toBe(403)
  })

  test("rejects non-loopback Host headers (DNS rebinding)", async () => {
    const res = await fetch(`${base}/api/hermes/session`, { headers: { host: "attacker.example" } })
    expect(res.status).toBe(403)
  })
})

// ---- T37: the route error paths and the approve endpoints. ----

describe("hermes api — error paths and approve routes", () => {
  test("fs/list answers 400 for a path that is not a directory", async () => {
    const r = await fetch(`${base}/api/hermes/fs/list?path=${encodeURIComponent(join(home, "config.yaml"))}`)
    expect(r.status).toBe(400)
    expect((await j(r)).message).toBe("not a directory")
  })

  test("approve all flips session yolo state; the GET reply is static", async () => {
    const post = (body: Record<string, boolean>) =>
      fetch(`${base}/api/hermes/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const yolo = async () => (await j(await fetch(`${base}/api/hermes/yolo?session=whatever`))).yolo

    expect(await j(await post({ all: true }))).toEqual({ ok: true, all: true })
    expect(await yolo()).toBe(true) // setAutoApproveAll reached sessionYoloState
    expect(await j(await post({ all: false }))).toEqual({ ok: true, all: false })
    expect(await yolo()).toBe(false) // reset: no leakage into later tests
    expect(await j(await fetch(`${base}/api/hermes/approve`))).toEqual({ all: false }) // GET never reports state
  })

  test("unknown api paths are 404", async () => {
    const r = await fetch(`${base}/api/hermes/nope`)
    expect(r.status).toBe(404)
    expect(await r.text()).toBe("Not found")
  })

  test("a corrupt database answers 500 with the sqlite message", async () => {
    const saved = process.env.HERMES_CANVAS_DB!
    const junk = join(home, "junk.db")
    writeFileSync(junk, "this is not a database")
    process.env.HERMES_CANVAS_DB = junk
    try {
      const r = await fetch(`${base}/api/hermes/session?limit=5`)
      expect(r.status).toBe(500)
      const msg = (await j(r)).message
      expect(typeof msg).toBe("string")
      expect(msg.length).toBeGreaterThan(0)
    } finally {
      process.env.HERMES_CANVAS_DB = saved
    }
  })

  test("boot reports a broken db on config and in the non-quiet banner", async () => {
    const saved = process.env.HERMES_CANVAS_DB!
    const junk = join(home, "boot-junk.db")
    writeFileSync(junk, "still not a database")
    process.env.HERMES_CANVAS_DB = junk
    const logs: string[] = []
    const origLog = console.log
    console.log = (...a: unknown[]) => void logs.push(a.join(" "))
    let boot: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      boot = await startServer({ port: 0, hostname: "127.0.0.1", demo: false, dev: false, quiet: false })
      const cfg = await j(await fetch(`http://127.0.0.1:${boot.server.port}/canvas/config`))
      expect(cfg.connected).toBe(false)
      expect(typeof cfg.error).toBe("string")
      expect(cfg.error!.length).toBeGreaterThan(0)
      expect(logs.join("\n")).toContain("unavailable")
    } finally {
      console.log = origLog
      boot?.stop()
      process.env.HERMES_CANVAS_DB = saved
    }
  })

  test("the non-quiet banner names the live db and the demo mode", async () => {
    const logs: string[] = []
    const origLog = console.log
    console.log = (...a: unknown[]) => void logs.push(a.join(" "))
    let live: Awaited<ReturnType<typeof startServer>> | undefined
    let demo: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      live = await startServer({ port: 0, hostname: "127.0.0.1", demo: false, dev: false, quiet: false })
      demo = await startServer({ port: 0, hostname: "127.0.0.1", demo: true, dev: false, quiet: false })
      const all = logs.join("\n")
      expect(all).toContain(process.env.HERMES_CANVAS_DB!) // live banner names the db
      expect(all).toContain("simulated sessions (demo)")
    } finally {
      console.log = origLog
      live?.stop()
      demo?.stop()
    }
  })
})

describe("hermes api — delivery modes, validation, permissions, and guard hardening", () => {
  test("busy session rejects without delivery (409) and supports delivery=steer", async () => {
    process.env.HERMES_FAKE_MODE = "hang"
    const ctrl = new AbortController()
    const stream = await fetch(`${base}/api/hermes/event`, { signal: ctrl.signal })
    const reader = stream.body!.getReader()
    const events: Array<{ type: string; data: any }> = []
    const collect = (async () => {
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) {
              try { events.push(JSON.parse(line.slice(6))) } catch { /* ignore */ }
            }
          }
        }
      }
    })()

    try {
      const first = await fetch(`${base}/api/hermes/session/ses_old_1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "first hang" }),
      })
      expect(first.status).toBe(200)

      const busy = await fetch(`${base}/api/hermes/session/ses_old_1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "second plain" }),
      })
      expect(busy.status).toBe(409)

      process.env.HERMES_FAKE_MODE = "fast"
      const steer = await fetch(`${base}/api/hermes/session/ses_old_1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "steered-now", delivery: "steer" }),
      })
      expect(steer.status).toBe(200)

      for (let i = 0; i < 100 && !events.some((e) => e.type === "session.text.delta" && String(e.data.delta).includes("steered-now")); i++) {
        await Bun.sleep(25)
      }
      expect(events.some((e) => e.type === "session.execution.interrupted")).toBe(true)
      expect(events.some((e) => e.type === "session.text.delta" && String(e.data.delta).includes("steered-now"))).toBe(true)
      for (let i = 0; i < 40 && (await j(await fetch(`${base}/api/hermes/session/active`))).ses_old_1; i++) {
        await Bun.sleep(25)
      }
    } finally {
      ctrl.abort()
      await collect.catch(() => {})
      process.env.HERMES_FAKE_MODE = "fast"
    }
  })

  test("delivery=queue waits for the active run and drains on settle; interrupt clears queue", async () => {
    const savedBin = process.env.HERMES_BIN
    const tmp = mkdtempSync(join(tmpdir(), "hermes-queue-"))
    const gate = join(tmp, "release")
    const fake = join(tmp, "gated-hermes.ts")
    writeFileSync(
      fake,
      [
        'import { existsSync } from "node:fs";',
        'const args = process.argv.slice(2);',
        'const qi = args.indexOf("-q");',
        'const q = qi >= 0 ? (args[qi + 1] ?? "") : "";',
        'console.log(JSON.stringify({ type: "system", subtype: "init" }));',
        'if (q.startsWith("hold")) {',
        `  while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(15);`,
        "}",
        'console.log(JSON.stringify({ type: "text", text: "heard: " + q }));',
        'console.log(JSON.stringify({ type: "result", exit_code: 0 }));',
        "",
      ].join("\n"),
    )
    process.env.HERMES_BIN = `bun ${fake}`
    const ctrl = new AbortController()
    const stream = await fetch(`${base}/api/hermes/event`, { signal: ctrl.signal })
    const reader = stream.body!.getReader()
    const deltas: string[] = []
    const collect = (async () => {
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                const ev = JSON.parse(line.slice(6))
                if (ev.type === "session.text.delta") deltas.push(ev.data.delta)
              } catch { /* ignore */ }
            }
          }
        }
      }
    })()

    try {
      const r1 = await fetch(`${base}/api/hermes/session/ses_new_1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hold-1" }),
      })
      expect(r1.status).toBe(200)

      const r2 = await fetch(`${base}/api/hermes/session/ses_new_1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "queued-2", delivery: "queue" }),
      })
      expect(r2.status).toBe(200)
      expect(await j(r2)).toEqual({ ok: true, queued: true })

      writeFileSync(gate, "go")
      for (let i = 0; i < 100 && !deltas.includes("heard: queued-2"); i++) await Bun.sleep(25)
      expect(deltas).toEqual(["heard: hold-1", "heard: queued-2"])
      for (let i = 0; i < 40 && (await j(await fetch(`${base}/api/hermes/session/active`))).ses_new_1; i++) {
        await Bun.sleep(25)
      }

      // Now verify POST /interrupt clears any queued prompts too.
      rmSync(gate, { force: true })
      deltas.length = 0
      await fetch(`${base}/api/hermes/session/ses_new_1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hold-2" }),
      })
      const queuedCancel = await fetch(`${base}/api/hermes/session/ses_new_1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "should-not-run", delivery: "queue" }),
      })
      expect(queuedCancel.status).toBe(200)
      await fetch(`${base}/api/hermes/session/ses_new_1/interrupt`, { method: "POST" })
      writeFileSync(gate, "go")
      await Bun.sleep(80)
      expect(deltas).not.toContain("heard: should-not-run")
    } finally {
      ctrl.abort()
      await collect.catch(() => {})
      if (savedBin === undefined) delete process.env.HERMES_BIN
      else process.env.HERMES_BIN = savedBin
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  test("validation, 404s, limits, and unknown sub-routes", async () => {
    // Malformed URI percent encoding
    expect((await fetch(`${base}/api/hermes/session/%E0%A4%A`)).status).toBe(400)

    // Invalid JSON / field types
    expect(
      (
        await fetch(`${base}/api/hermes/session/ses_new_1/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: 123 }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await fetch(`${base}/api/hermes/session/ses_new_1/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hi", delivery: "later" }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await fetch(`${base}/api/hermes/session/ses_new_1/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not-json",
        })
      ).status,
    ).toBe(400)
    expect((await fetch(`${base}/api/hermes/session/ses_new_1/message?cursor=bad`)).status).toBe(400)
    expect(
      (
        await fetch(`${base}/api/hermes/session/ses_new_1/view`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idle: -1 }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await fetch(`${base}/api/hermes/session/ses_new_1`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "   " }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await fetch(`${base}/api/hermes/session/ses_new_1/model`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: {} }),
        })
      ).status,
    ).toBe(400)

    // Missing session returns 404 on PATCH / message / model / view
    expect((await fetch(`${base}/api/hermes/session/nope/message`)).status).toBe(404)
    expect(
      (
        await fetch(`${base}/api/hermes/session/nope`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ permissions: null }),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await fetch(`${base}/api/hermes/session/nope/model`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: { id: "x", providerID: "p" } }),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await fetch(`${base}/api/hermes/session/nope/view`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(404)

    // Unknown session sub-route is 404 (not 200 ok:true)
    expect((await fetch(`${base}/api/hermes/session/ses_new_1/nonexistent`)).status).toBe(404)
    expect((await fetch(`${base}/api/hermes/session/ses_new_1/nonexistent`, { method: "POST" })).status).toBe(404)

    // Negative limit clamps cleanly
    const page = await j(await fetch(`${base}/api/hermes/session?limit=-5`))
    expect(page.data.length).toBeGreaterThanOrEqual(2)

    // approve accepts { approve } alias
    try {
      expect(
        await j(
          await fetch(`${base}/api/hermes/approve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ approve: true }),
          }),
        ),
      ).toEqual({ ok: true, all: true })
    } finally {
      await fetch(`${base}/api/hermes/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: false }),
      })
    }

    // Event endpoint requires GET
    expect((await fetch(`${base}/api/hermes/event`, { method: "POST" })).status).toBe(405)
  })

  test("permissions require wildcard action and resource, and reflect in GET /session/:id", async () => {
    const partial = await fetch(`${base}/api/hermes/session/ses_new_1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissions: [{ action: "read", resource: "*", effect: "allow" }] }),
    })
    expect(partial.status).toBe(200)
    expect((await j(await fetch(`${base}/api/hermes/yolo?session=ses_new_1`))).yolo).toBe(false)

    await fetch(`${base}/api/hermes/session/ses_new_1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }),
    })
    expect((await j(await fetch(`${base}/api/hermes/yolo?session=ses_new_1`))).yolo).toBe(true)
    expect((await j(await fetch(`${base}/api/hermes/session/ses_new_1`))).permissions).toEqual([
      { action: "*", resource: "*", effect: "allow" },
    ])

    await fetch(`${base}/api/hermes/session/ses_new_1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissions: null }),
    })
    expect((await j(await fetch(`${base}/api/hermes/session/ses_new_1`))).permissions).toBeNull()

    const created = await j(
      await fetch(`${base}/api/hermes/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          location: { directory: home },
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
        }),
      }),
    )
    expect(created.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }])
  })

  test("guard handles case-insensitive loopback and IPv6 brackets safely", async () => {
    expect(isLoopbackHost("LOCALHOST:4318")).toBe(true)
    expect(isLoopbackHost("[::1]:4318")).toBe(true)
    expect(isLoopbackHost("::1")).toBe(true)
    expect(isLoopbackHost("[::1].evil.com")).toBe(false)
    expect(isLoopbackHost("localhost:abc")).toBe(false)

    expect((await fetch(`${base}/api/hermes/model`, { headers: { host: "LOCALHOST:4318" } })).status).toBe(200)
    expect((await fetch(`${base}/api/hermes/model`, { headers: { host: "[::1]:4318" } })).status).toBe(200)
    expect((await fetch(`${base}/api/hermes/model`, { headers: { host: "[::1]" } })).status).toBe(200)
    expect((await fetch(`${base}/api/hermes/model`, { headers: { host: "localhost.evil.com" } })).status).toBe(403)
    expect((await fetch(`${base}/api/hermes/model`, { headers: { host: "127.0.0.2" } })).status).toBe(403)
    expect([400, 403]).toContain((await fetch(`${base}/api/hermes/model`, { headers: { host: "localhost:abc" } })).status)
  })

  test("demo mode ignores broken db and stop closes open SSE streams", async () => {
    const saved = process.env.HERMES_CANVAS_DB
    process.env.HERMES_CANVAS_DB = join(home, "nonexistent.db")
    const demo = await startServer({ port: 0, hostname: "127.0.0.1", demo: true, dev: false, quiet: true })
    try {
      const cfg = await j(await fetch(`http://127.0.0.1:${demo.server.port}/canvas/config`))
      expect(cfg.connected).toBe(true)
      expect(cfg.error).toBeUndefined()

      const res = await fetch(`http://127.0.0.1:${demo.server.port}/api/hermes/event`)
      const reader = res.body!.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)
      demo.stop()
      const ended = await Promise.race([
        reader.read().then((r) => r.done, () => true),
        Bun.sleep(2000).then(() => false),
      ])
      expect(ended).toBe(true)

      // Live server booted against a missing DB recovers on /canvas/config once DB appears.
      const recoverable = await startServer({ port: 0, hostname: "127.0.0.1", demo: false, dev: false, quiet: true })
      try {
        const bad = await j(await fetch(`http://127.0.0.1:${recoverable.server.port}/canvas/config`))
        expect(bad.connected).toBe(false)
        process.env.HERMES_CANVAS_DB = saved!
        const ok = await j(await fetch(`http://127.0.0.1:${recoverable.server.port}/canvas/config`))
        expect(ok.connected).toBe(true)
        expect(ok.error).toBeUndefined()
      } finally {
        recoverable.stop()
      }
    } finally {
      demo.stop()
      if (saved === undefined) delete process.env.HERMES_CANVAS_DB
      else process.env.HERMES_CANVAS_DB = saved
    }
  })
})
