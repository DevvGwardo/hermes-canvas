// HTTP server: serves the canvas UI and answers /api/hermes/* straight from
// the local Hermes session store (state.db), so the browser never touches
// the database file or the `hermes` CLI directly.

import index from "../app/index.html"
import { homedir } from "node:os"
import {
  createSessionRow,
  dbPath,
  defaultModel,
  getSession,
  getSessionModel,
  hermesHome,
  interruptAllPrompts,
  interruptSession,
  isPromptBusy,
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
  uid,
  waitForPromptExit,
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

const encoder = new TextEncoder()

export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  let name: string
  if (h.startsWith("[")) {
    const end = h.indexOf("]")
    if (end < 0) return false
    const rest = h.slice(end + 1)
    if (rest && !/^:\d+$/.test(rest)) return false
    name = h.slice(1, end)
  } else {
    const idx = h.lastIndexOf(":")
    if (idx > 0 && h.indexOf(":") === idx) {
      const port = h.slice(idx + 1)
      if (!/^\d+$/.test(port)) return false
      name = h.slice(0, idx)
    } else {
      name = h
    }
  }
  return name === "localhost" || name === "127.0.0.1" || name === "::1"
}

function parseReqUrl(req: Request): URL | undefined {
  try {
    return new URL(req.url)
  } catch {
    return undefined
  }
}

async function readJson(req: Request): Promise<Record<string, any> | undefined> {
  try {
    const text = await req.text()
    if (!text.trim()) return {}
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return parsed as Record<string, any>
  } catch {
    return undefined
  }
}

function formatModel(m: unknown): string | undefined {
  if (!m || typeof m !== "object") return undefined
  const { id, providerID } = m as { id?: unknown; providerID?: unknown }
  if (typeof id !== "string" || !id.trim()) return undefined
  const mid = id.trim()
  const pid = typeof providerID === "string" ? providerID.trim() : ""
  return pid ? `${pid}/${mid}` : mid
}

export async function startServer(opts: ServerOptions) {
  const viewed = loadViewed()
  const listeners = new Set<(ev: CanvasEvent) => void>()
  const sseClosers = new Set<() => void>()
  type QueuedPrompt = { text: string; model?: string; cwd?: string }
  const promptQueues = new Map<string, QueuedPrompt[]>()
  const steerTokens = new Map<string, number>()
  let stopped = false

  const emit = (ev: CanvasEvent) => {
    for (const l of [...listeners]) {
      try {
        l(ev)
      } catch { /* a dead SSE sink must not break the bus */ }
    }
  }

  let dbError: string | undefined
  if (!opts.demo) {
    try {
      listSessions(1, viewed, new Set())
    } catch (e) {
      dbError = (e as Error).message
    }
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

  const launchPrompt = async (id: string, text: string, model: string | undefined, cwd: string): Promise<void> => {
    await startPrompt(id, text, {
      emit,
      model,
      cwd,
      onSettled: (reason) => {
        if (stopped || reason !== "ended") return
        const q = promptQueues.get(id)
        const next = q?.shift()
        if (q && q.length === 0) promptQueues.delete(id)
        if (!next) return
        const cur = getSession(id, viewed, runningSessionIDs())
        void launchPrompt(id, next.text, next.model, next.cwd ?? cur?.location.directory ?? cwd).catch(() => {})
      },
    })
  }

  const stopWatcher = opts.demo ? undefined : startWatcher(emit)

  async function hermesApi(req: Request, server: Bun.Server<unknown>): Promise<Response> {
    const url = parseReqUrl(req)
    if (!url) return new Response("Bad Request", { status: 400 })
    const blocked = guard(req, url)
    if (blocked) return blocked
    const path = url.pathname.slice("/api/hermes".length) || "/"
    const running = runningSessionIDs()

    try {
      // Live event feed.
      if (path === "/event") {
        if (req.method !== "GET") {
          return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } })
        }
        server.timeout(req, 0)
        let cleanup: (() => void) | undefined
        const body = new ReadableStream({
          start(c) {
            let alive = true
            const teardown = () => {
              if (!alive) return
              alive = false
              listeners.delete(send)
              sseClosers.delete(closeStream)
              clearInterval(keepalive)
              req.signal.removeEventListener("abort", teardown)
            }
            const closeStream = () => {
              teardown()
              try { c.close() } catch { /* already closed */ }
            }
            const send = (ev: CanvasEvent) => {
              if (!alive) return
              try {
                c.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`))
              } catch {
                teardown()
              }
            }
            const keepalive = setInterval(() => {
              if (!alive) return
              try {
                c.enqueue(encoder.encode(": ping\n\n"))
              } catch {
                teardown()
              }
            }, 30_000)
            keepalive.unref?.()
            cleanup = teardown
            sseClosers.add(closeStream)
            req.signal.addEventListener("abort", teardown, { once: true })
            send({ id: "init", type: "server.connected", created: Date.now(), data: {} })
            listeners.add(send)
          },
          cancel() {
            cleanup?.()
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
        const rawLimit = url.searchParams.get("limit")
        const n = rawLimit !== null ? Number(rawLimit) : 600
        const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 600) : 600
        const q = url.searchParams.get("search")
        if (q) return Response.json({ data: searchSessions(q, limit, viewed, running), cursor: {} })
        return Response.json({ data: listSessions(limit, viewed, running), cursor: {} })
      }
      if ((path === "/session" || path === "/session/") && req.method === "POST") {
        const body = await readJson(req)
        if (!body) return Response.json({ message: "invalid JSON body" }, { status: 400 })
        if (body.location !== undefined && (typeof body.location !== "object" || body.location === null)) {
          return Response.json({ message: "invalid location" }, { status: 400 })
        }
        if (body.location?.directory !== undefined && typeof body.location.directory !== "string") {
          return Response.json({ message: "directory must be a string" }, { status: 400 })
        }
        if (body.model !== undefined && body.model !== null && !formatModel(body.model)) {
          return Response.json({ message: "invalid model" }, { status: 400 })
        }
        if (body.permissions !== undefined && !Array.isArray(body.permissions)) {
          return Response.json({ message: "permissions must be an array" }, { status: 400 })
        }
        const dir = body.location?.directory ?? homedir()
        const model = formatModel(body.model)
        const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined
        const allowAll = (body.permissions ?? []).some(
          (p: any) => p && p.action === "*" && p.resource === "*" && p.effect === "allow",
        )
        const s = createSessionRow(dir, model, title, allowAll)
        emit({
          id: uid("evt"),
          type: "session.created",
          created: Date.now(),
          data: { sessionID: s.id, projectID: s.projectID, agent: s.agent, model: s.model, title: s.title, location: s.location },
        })
        return Response.json(s)
      }

      const m = path.match(/^\/session\/([^/]+)(?:\/(.*))?$/)
      if (m) {
        let id: string
        try {
          id = decodeURIComponent(m[1])
        } catch {
          return Response.json({ message: "invalid session id" }, { status: 400 })
        }
        if (!id) return new Response("Not found", { status: 404 })
        const sub = (m[2] ?? "").replace(/\/+$/, "").split("/")[0]
        if (!sub && req.method === "GET") {
          const s = getSession(id, viewed, running)
          if (!s) return Response.json({ message: "session not found" }, { status: 404 })
          return Response.json(s)
        }
        if (!sub && req.method === "PATCH") {
          const s = getSession(id, viewed, running)
          if (!s) return Response.json({ message: "session not found" }, { status: 404 })
          const body = await readJson(req)
          if (!body) return Response.json({ message: "invalid JSON body" }, { status: 400 })
          if (body.title !== undefined) {
            if (typeof body.title !== "string" || !body.title.trim()) {
              return Response.json({ message: "invalid title" }, { status: 400 })
            }
            const nextTitle = body.title.trim()
            await renameSession(id, nextTitle)
            emit({ id: uid("evt"), type: "session.renamed", created: Date.now(), data: { sessionID: id, title: nextTitle } })
          }
          // Hermes has no server-side permission rules; the canvas
          // allow-everything rule maps to --yolo on spawned prompts instead.
          if (body.permissions !== undefined) {
            if (body.permissions !== null && !Array.isArray(body.permissions)) {
              return Response.json({ message: "permissions must be an array or null" }, { status: 400 })
            }
            const rules = Array.isArray(body.permissions) ? body.permissions : []
            const allowAll = rules.some(
              (r: any) => r && r.action === "*" && r.resource === "*" && r.effect === "allow",
            )
            setSessionYolo(id, allowAll)
          }
          return Response.json({ ok: true })
        }
        if (sub === "message" && req.method === "GET") {
          const s = getSession(id, viewed, running)
          if (!s) return Response.json({ message: "session not found" }, { status: 404 })
          const rawLimit = url.searchParams.get("limit")
          const n = rawLimit !== null ? Number(rawLimit) : 100
          const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : 100
          const cursor = url.searchParams.get("cursor") ?? undefined
          if (cursor !== undefined && cursor !== "" && !/^\d+$/.test(cursor)) {
            return Response.json({ message: "invalid cursor" }, { status: 400 })
          }
          return Response.json(sessionMessages(id, limit, cursor || undefined))
        }
        if (sub === "prompt" && req.method === "POST") {
          const body = await readJson(req)
          if (!body) return Response.json({ message: "invalid JSON body" }, { status: 400 })
          if (typeof body.text !== "string") {
            return Response.json({ message: "text must be a string" }, { status: 400 })
          }
          const text = body.text.trim()
          if (!text) return Response.json({ message: "empty prompt" }, { status: 400 })
          if (body.delivery !== undefined && body.delivery !== "steer" && body.delivery !== "queue") {
            return Response.json({ message: "invalid delivery" }, { status: 400 })
          }
          if (body.model !== undefined && body.model !== null && !formatModel(body.model)) {
            return Response.json({ message: "invalid model" }, { status: 400 })
          }
          const s = getSession(id, viewed, running)
          if (!s) return Response.json({ message: "session not found" }, { status: 404 })
          const model = formatModel(body.model) ?? getSessionModel(id)

          if (isPromptBusy(id)) {
            if (body.delivery === "queue") {
              const q = promptQueues.get(id) ?? []
              q.push({ text, model, cwd: s.location.directory })
              promptQueues.set(id, q)
              return Response.json({ ok: true, queued: true })
            }
            if (body.delivery === "steer") {
              const token = (steerTokens.get(id) ?? 0) + 1
              steerTokens.set(id, token)
              const stoppedNow = interruptSession(id)
              if (stoppedNow) {
                emit({ id: uid("evt"), type: "session.execution.interrupted", created: Date.now(), data: { sessionID: id } })
              }
              await waitForPromptExit(id)
              if (stopped || steerTokens.get(id) !== token) {
                return Response.json({ message: "steer cancelled" }, { status: 409 })
              }
              try {
                await launchPrompt(id, text, model, s.location.directory)
              } catch (err) {
                if (/already running/i.test((err as Error).message)) {
                  return Response.json({ message: (err as Error).message }, { status: 409 })
                }
                throw err
              }
              return Response.json({ ok: true })
            }
            return Response.json({ message: "session is already running" }, { status: 409 })
          }

          try {
            await launchPrompt(id, text, model, s.location.directory)
          } catch (err) {
            if (/already running/i.test((err as Error).message)) {
              return Response.json({ message: (err as Error).message }, { status: 409 })
            }
            throw err
          }
          return Response.json({ ok: true })
        }
        if (sub === "interrupt" && req.method === "POST") {
          promptQueues.delete(id)
          steerTokens.set(id, (steerTokens.get(id) ?? 0) + 1)
          const stoppedRun = interruptSession(id)
          if (stoppedRun) {
            emit({ id: uid("evt"), type: "session.execution.interrupted", created: Date.now(), data: { sessionID: id } })
          }
          return Response.json({ ok: true, stopped: stoppedRun })
        }
        if (sub === "view" && req.method === "POST") {
          const s = getSession(id, viewed, running)
          if (!s) return Response.json({ message: "session not found" }, { status: 404 })
          const body = await readJson(req)
          if (!body) return Response.json({ message: "invalid JSON body" }, { status: 400 })
          if (body.idle !== undefined && (typeof body.idle !== "number" || !Number.isFinite(body.idle) || body.idle < 0)) {
            return Response.json({ message: "invalid idle timestamp" }, { status: 400 })
          }
          viewed.set(id, Math.max(body.idle ?? Date.now(), Date.now()))
          saveViewed(viewed)
          return Response.json({ ok: true })
        }
        if (sub === "model" && req.method === "POST") {
          const body = await readJson(req)
          if (!body) return Response.json({ message: "invalid JSON body" }, { status: 400 })
          const model = formatModel(body.model)
          if (!model) return Response.json({ message: "invalid model" }, { status: 400 })
          if (!setSessionModel(id, model)) {
            return Response.json({ message: "session not found" }, { status: 404 })
          }
          emit({
            id: uid("evt"),
            type: "session.model.selected",
            created: Date.now(),
            data: {
              sessionID: id,
              model: {
                id: String(body.model.id).trim(),
                providerID: (typeof body.model.providerID === "string" && body.model.providerID.trim()) || "hermes",
              },
            },
          })
          return Response.json({ ok: true })
        }
        // Hermes has no permission/form/inbox queues: report empty so the
        // canvas never shows a phantom "needs you", and accept replies.
        if ((sub === "permission" || sub === "inbox" || sub === "form") && req.method === "GET") {
          return Response.json([])
        }
        if ((sub === "permission" || sub === "inbox" || sub === "form") && (req.method === "POST" || req.method === "DELETE")) {
          return Response.json({ ok: true })
        }
        return new Response("Not found", { status: 404 })
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
        const body = await readJson(req)
        if (!body) return Response.json({ message: "invalid JSON body" }, { status: 400 })
        const on = body.all !== undefined ? !!body.all : !!body.approve
        setAutoApproveAll(on)
        return Response.json({ ok: true, all: on })
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
        const url = parseReqUrl(req)
        if (!url) return new Response("Bad Request", { status: 400 })
        const blocked = guard(req, url)
        if (blocked) return blocked
        if (!opts.demo && dbError) {
          try {
            listSessions(1, viewed, new Set())
            dbError = undefined
          } catch (e) {
            dbError = (e as Error).message
          }
        }
        return Response.json({
          mode: opts.demo ? "demo" : "live",
          backend: "hermes",
          connected: opts.demo ? true : !dbError,
          version: opts.demo ? undefined : "hermes",
          upstream: dbPath(),
          home: hermesHome(),
          userHome: homedir(),
          error: dbError,
        })
      },
    },
    fetch(req, server) {
      const url = parseReqUrl(req)
      if (!url) return new Response("Bad Request", { status: 400 })
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
      stopped = true
      for (const close of [...sseClosers]) close()
      for (const q of promptQueues.values()) q.length = 0
      promptQueues.clear()
      steerTokens.clear()
      stopWatcher?.()
      void interruptAllPrompts()
      server.stop(true)
    },
  }
}
