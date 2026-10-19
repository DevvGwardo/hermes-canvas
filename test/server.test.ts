import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeHermesHome } from "./helpers"
import { startServer } from "../src/server/server"

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
    try {
      const res = await fetch(`${base}/api/hermes/session/ses_old_1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "long task" }),
      })
      expect(res.status).toBe(200)
      await Bun.sleep(300)
      const stopRes = await j(
        await fetch(`${base}/api/hermes/session/ses_old_1/interrupt`, { method: "POST" }),
      )
      expect(stopRes.stopped).toBe(true)
      const active = await j(await fetch(`${base}/api/hermes/session/active`))
      expect(active.ses_old_1).toBeUndefined()
    } finally {
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
