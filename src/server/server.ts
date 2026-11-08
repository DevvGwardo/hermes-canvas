// HTTP server: serves the canvas UI and answers /api/hermes/* straight from
// the local Hermes session store (state.db), so the browser never touches
// the database file or the `hermes` CLI directly.

import index from "../app/index.html"
import { homedir } from "node:os"
import {
  backfillProfileNames,
  createSessionRow,
  dbPath,
  defaultModel,
  getSession,
  hermesHome,
  interruptSession,
  listFolders,
  listModels,
  listProjects,
  listSessions,
  loadViewed,
  renameSession,
  runningSessionIDs,
  saveViewed,
  searchSessions,
  sessionMessages,
  setAutoApproveAll,
  setSessionModel,
  setSessionYolo,
  sessionYoloState,
  startPrompt,
  startWatcher,
  type CanvasEvent,
} from "./hermes"

export interface ServerOptions {
  port: number
  hostname: string
  demo: boolean
  dev: boolean
  /** Don't log connection changes (tests). */
  quiet?: boolean
}

function isLoopbackHost(host: string | null) {
  if (!host) return false
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "")
  return name === "localhost" || name === "127.0.0.1" || name === "::1"
}

export async function startServer(opts: ServerOptions) {
  const viewed = loadViewed()
  const listeners = new Set<(ev: CanvasEvent) => void>()
  const emit = (ev: CanvasEvent) => {
    for (const l of [...listeners]) {
      try {
        l(ev)
      } catch { /* a dead SSE sink must not break the bus */ }
    }
  }
  let dbError: string | undefined
  try {
    backfillProfileNames()
    listSessions(1, viewed, new Set())
  } catch (e) {
    dbError = (e as Error).message
  }

  const loopbackOnly = isLoopbackHost(opts.hostname)

  // Blocks other websites from driving Hermes through this server (CSRF) and
  // DNS-rebinding attacks against the loopback listener.
  function guard(req: Request, url: URL): Response | undefined {
    if (loopbackOnly && !isLoopbackHost(req.headers.get("host"))) {
      return new Response("Forbidden host", { status: 403 })
    }
    const origin = req.headers.get("origin")
    if (origin && origin !== url.origin) return new Response("Forbidden origin", { status: 403 })
    const site = req.headers.get("sec-fetch-site")
    if (site && site !== "same-origin" && site !== "none") return new Response("Forbidden", { status: 403 })
    return undefined
  }

  const stopWatcher = opts.demo ? undefined : startWatcher(emit)

  async function hermesApi(req: Request, server: Bun.Server<unknown>): Promise<Response> {
    const url = new URL(req.url)
    const blocked = guard(req, url)
    if (blocked) return blocked
    const path = url.pathname.slice("/api/hermes".length) || "/"
    const running = runningSessionIDs()

    try {
      // Live event feed.
      if (path === "/event") {
        server.timeout(req, 0)
        let close: (() => void) | undefined
        const body = new ReadableStream({
          start(c) {
            const send = (ev: CanvasEvent) => {
              try {
                c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ev)}\n\n`))
              } catch { /* sink closed */ }
            }
            send({ id: "init", type: "server.connected", created: Date.now(), data: {} })
            listeners.add(send)
            close = () => listeners.delete(send)
          },
          cancel() {
            close?.()
          },
        })
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        })
      }

      if (path === "/project" && req.method === "GET") return Response.json(listProjects())
      if (path === "/model" && req.method === "GET") return Response.json(listModels())
      if (path === "/model/default" && req.method === "GET") return Response.json(defaultModel() ?? null)
      if (path === "/session/active" && req.method === "GET") {
        return Response.json(Object.fromEntries([...running].map((id) => [id, { type: "running" }])))
      }
      if ((path === "/session" || path === "/session/") && req.method === "GET") {
        const q = url.searchParams.get("search")
        if (q) return Response.json({ data: searchSessions(q), cursor: {} })
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 600) || 600, 600)
        return Response.json({ data: listSessions(limit, viewed, running), cursor: {} })
      }
      if ((path === "/session" || path === "/session/") && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          location?: { directory?: string }
          model?: { id?: string; providerID?: string }
          permissions?: Array<{ action: string; resource: string; effect: string }>
        }
        const dir = body.location?.directory ?? homedir()
        const model = body.model ? `${body.model.providerID ?? ""}/${body.model.id ?? ""}`.replace(/^\//, "") : undefined
        const s = createSessionRow(dir, model)
        const allowAll = (body.permissions ?? []).some((p) => p.action === "*" && p.effect === "allow")
        if (allowAll) setSessionYolo(s.id, true)
        emit({
          id: `evt_${Date.now()}`,
          type: "session.created",
          created: Date.now(),
          data: { sessionID: s.id, projectID: s.projectID, agent: s.agent, model: s.model, title: s.title, location: s.location },
        })
        return Response.json(s)
      }

      const m = path.match(/^\/session\/([^/]+)(?:\/(.*))?$/)
      if (m) {
        const id = decodeURIComponent(m[1])
        const sub = (m[2] ?? "").replace(/\/+$/, "").split("/")[0]
        if (!sub && req.method === "GET") {
          const s = getSession(id, viewed, running)
          if (!s) return Response.json({ message: "session not found" }, { status: 404 })
          return Response.json(s)
        }
        if (!sub && req.method === "PATCH") {
          const body = (await req.json().catch(() => ({}))) as { title?: string; permissions?: unknown }
          if (typeof body.title === "string") {
            await renameSession(id, body.title)
            emit({ id: `evt_${Date.now()}`, type: "session.renamed", created: Date.now(), data: { sessionID: id, title: body.title } })
          }
          // Hermes has no server-side permission rules; the canvas
          // allow-everything rule maps to --yolo on spawned prompts instead.
          if (body.permissions !== undefined) {
            const rules = Array.isArray(body.permissions) ? body.permissions : []
            const allowAll = rules.some(
              (r: any) => r && (r.action === "*" || r.resource === "*") && r.effect === "allow",
            )
            setSessionYolo(id, allowAll)
          }
          return Response.json({ ok: true })
        }
        if (sub === "message" && req.method === "GET") {
          const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 200)
          const cursor = url.searchParams.get("cursor") ?? undefined
          return Response.json(sessionMessages(id, limit, cursor))
        }
        if (sub === "prompt" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { text?: string; delivery?: string; model?: { id?: string; providerID?: string } }
          const text = (body.text ?? "").trim()
          if (!text) return Response.json({ message: "empty prompt" }, { status: 400 })
          const s = getSession(id, viewed, running)
          if (!s) return Response.json({ message: "session not found" }, { status: 404 })
          const model = body.model ? `${body.model.providerID ?? ""}/${body.model.id ?? ""}`.replace(/^\//, "") : undefined
          await startPrompt(id, text, { emit, model, cwd: s.location.directory })
          return Response.json({ ok: true })
        }
        if (sub === "interrupt" && req.method === "POST") {
          const stopped = interruptSession(id)
          if (stopped) {
            emit({ id: `evt_${Date.now()}`, type: "session.execution.interrupted", created: Date.now(), data: { sessionID: id } })
          }
          return Response.json({ ok: true, stopped })
        }
        if (sub === "view" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { idle?: number }
          viewed.set(id, Math.max(body.idle ?? Date.now(), Date.now()))
          saveViewed(viewed)
          return Response.json({ ok: true })
        }
        if (sub === "model" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { model?: { id?: string; providerID?: string } }
          if (body.model) {
            const model = `${body.model.providerID ?? ""}/${body.model.id ?? ""}`.replace(/^\//, "")
            setSessionModel(id, model)
            emit({
              id: `evt_${Date.now()}`,
              type: "session.model.selected",
              created: Date.now(),
              data: { sessionID: id, model: { id: body.model.id, providerID: body.model.providerID } },
            })
          }
          return Response.json({ ok: true })
        }
        // Hermes has no permission/form/inbox queues: report empty so the
        // canvas never shows a phantom "needs you", and accept replies.
        if ((sub === "permission" || sub === "inbox" || sub === "form") && req.method === "GET") {
          return Response.json([])
        }
        return Response.json({ ok: true })
      }

      if (path === "/fs/list" && req.method === "GET") {
        const p = url.searchParams.get("path") ?? ""
        try {
          const dirs = listFolders(p)
          return Response.json({ data: dirs.map((d) => ({ path: d, type: "directory" })) })
        } catch (e) {
          return Response.json({ message: (e as Error).message }, { status: 400 })
        }
      }
      if (path === "/approve" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { all?: boolean }
        setAutoApproveAll(!!body.all)
        return Response.json({ ok: true, all: !!body.all })
      }
      if (path === "/approve" && req.method === "GET") {
        return Response.json({ all: false })
      }
      if (path === "/yolo" && req.method === "GET") {
        const id = url.searchParams.get("session") ?? ""
        return Response.json({ yolo: sessionYoloState(id) })
      }

      return new Response("Not found", { status: 404 })
    } catch (e) {
      return Response.json({ message: (e as Error).message }, { status: 500 })
    }
  }

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    idleTimeout: 255,
    development: opts.dev ? { hmr: true, console: false } : false,
    routes: {
      "/": index,
      "/canvas/config": (req) => {
        const blocked = guard(req, new URL(req.url))
        if (blocked) return blocked
        return Response.json({
          mode: opts.demo ? "demo" : "live",
          backend: "hermes",
          connected: opts.demo ? true : !dbError,
          version: opts.demo ? undefined : "hermes",
          upstream: dbPath(),
          home: hermesHome(),
          error: dbError,
        })
      },
    },
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === "/api/hermes/event" || url.pathname.startsWith("/api/hermes/")) return hermesApi(req, server)
      return new Response("Not found", { status: 404 })
    },
  })

  if (!opts.quiet) {
    if (opts.demo) console.log(`  hermes    simulated sessions (demo)`)
    else if (dbError) console.log(`  hermes    \x1b[31munavailable\x1b[0m  ${dbError}`)
    else console.log(`  hermes    ${dbPath()}`)
  }

  return {
    server,
    stop: () => {
      stopWatcher?.()
      server.stop(true)
    },
  }
}
