// Simulated sessions: in-memory sessions that emit the same canvas events as
// the real backends. Used by --demo / ?demo, and handy for working on the UI.

import type { Backend, ConnectionState, PromptInput } from "./backend"
import type {
  Delivery,
  FormInfo,
  InboxItem,
  Message,
  ModelRef,
  PermissionRule,
  OcEvent,
  Page,
  PermissionDecision,
  PermissionRequest,
  Project,
  Session,
} from "./types"

type Assistant = Extract<Message, { type: "assistant" }>

const MIN = 60_000
const HR = 60 * MIN

const PROJECTS: Array<[string, string]> = [
  ["p_web", "storefront-web"],
  ["p_mobile", "mobile-app"],
  ["p_api", "payments-api"],
  ["p_ds", "design-system"],
  ["p_data", "data-pipeline"],
  ["p_docs", "docs-site"],
  ["p_infra", "infra"],
]

interface Seed {
  project: string
  title: string
  ago: number
  text: string
  subagents?: number
  running?: boolean
  outcome?: Session["outcome"]
  user?: string
  unseen?: boolean
}

const SEEDS: Seed[] = [
  { project: "p_web", title: "Checkout redesign", ago: 2 * MIN, running: true, subagents: 4, user: "Can we keep the old flow behind a flag for a week?", text: "The new checkout is **two steps instead of four**. Address and payment now share one screen, and the order summary stays pinned on desktop.\n\nLighthouse is at **96** on mobile. I'm wiring the analytics events next." },
  { project: "p_web", title: "Fix flaky cart tests", ago: 9 * MIN, running: true, subagents: 2, text: "The flake comes from a shared fake clock between test files.\n\n- Give each suite its own clock\n- Drop the retry wrapper that hid it" },
  { project: "p_web", title: "Image CDN migration", ago: 12 * MIN, subagents: 1, text: "Product images now come from the CDN with AVIF first. Read 6 files, patched 3, ran 4 commands." },
  { project: "p_mobile", title: "Offline mode for the order list", ago: 3 * MIN, running: true, subagents: 3, text: "Orders are cached on first load and reconciled when the network returns.\n\n- Queue writes while offline\n- Show a sync badge on stale rows" },
  { project: "p_mobile", title: "Push notification permissions", ago: 26 * HR, text: "We now ask after the first completed order instead of on launch. Opt-in went from 41% to 63% in the test build." },
  { project: "p_mobile", title: "Crash on rotating the camera screen", ago: 14 * HR, text: "The preview layer was released twice on rotation. Fixed and covered by a UI test." },
  { project: "p_api", title: "Refund webhooks", ago: 5 * MIN, running: true, subagents: 3, text: "Refunds now emit `refund.succeeded` and `refund.failed`. Ready to push the branch so CI can run the contract tests.\n\n- Signed payloads, retried with backoff" },
  { project: "p_api", title: "Rate limit the search endpoint", unseen: true, ago: 4 * HR, text: "Search is limited to 30 requests a minute per key, with a clear `Retry-After` header." },
  { project: "p_api", title: "Upgrade the Postgres driver", unseen: true, ago: 30 * HR, outcome: "failed", text: "Two queries rely on the old implicit casting. Leaving the upgrade until those are rewritten." },
  { project: "p_ds", title: "Dark mode tokens", unseen: true, ago: 10 * MIN, subagents: 1, text: "Every color is now a token with a light and dark value. Inline code renders as a rounded pill, and links use the accent blue." },
  { project: "p_ds", title: "Button focus rings", ago: 1 * MIN, running: true, subagents: 2, text: "Focus rings now follow the button's radius and stay visible on every background. Checking contrast across all twelve variants." },
  { project: "p_ds", title: "Date picker keyboard support", ago: 40 * MIN, subagents: 2, text: "Arrow keys move by day, Page Up and Page Down by month, Home and End to the week edges.\n\n- Screen reader labels for every cell" },
  { project: "p_ds", title: "Storybook build speedup", ago: 55 * MIN, subagents: 1, text: "Cold builds went from 94s to 31s by moving to the new builder and caching the docs plugin." },
  { project: "p_data", title: "Nightly export to the warehouse", ago: 18 * MIN, running: true, subagents: 4, text: "I'll post row counts for each table as it lands.\n\n- Orders and refunds first\n- Then the event stream" },
  { project: "p_data", title: "Deduplicate signup events", ago: 15 * HR, text: "Duplicates came from a client retry with a new event ID. Dedupe now keys on the request ID." },
  { project: "p_docs", title: "Quickstart rewrite", ago: 4 * MIN, running: true, subagents: 2, text: "The quickstart now gets to a first API call in five minutes, with copyable snippets for curl, Node and Python." },
  { project: "p_docs", title: "Broken links sweep", unseen: true, ago: 14 * MIN, subagents: 3, text: "Fixed 23 broken links and added a link check to CI so new ones fail the build." },
  { project: "p_infra", title: "Move staging to the new cluster", ago: 3 * HR, subagents: 3, text: "Staging runs on the new cluster. DNS switched over with no downtime; the old nodes drain tonight." },
  { project: "p_infra", title: "Cut the build cache size", ago: 14 * HR, text: "Cache is down from 9 GB to 2.1 GB by pruning old layers and sharing the dependency layer." },
  { project: "p_infra", title: "Certificate renewal alerts", ago: 22 * HR, text: "Alerts fire 21 and 7 days before expiry, routed to the on-call channel." },
  { project: "p_infra", title: "Investigate slow deploys", ago: 28 * HR, outcome: "interrupted", text: "Most of the time is image pulls on cold nodes. Paused to wait on the cluster move." },
  { project: "p_infra", title: "Cost review", ago: 3 * 24 * HR, text: "Idle preview environments were a third of the bill. They now shut down after two hours without traffic." },
]

const SCRIPT: Array<{ tool: string; input: Record<string, any>; output: string }> = [
  { tool: "read", input: { path: "src/checkout/summary.tsx" }, output: "Read 212 lines" },
  { tool: "grep", input: { pattern: "useCartTotals", path: "src" }, output: "src/checkout/summary.tsx:18\nsrc/cart/drawer.tsx:41" },
  { tool: "edit", input: { path: "src/checkout/summary.tsx" }, output: "Applied 1 edit" },
  { tool: "shell", input: { command: "bun test" }, output: "128 pass, 0 fail" },
  { tool: "subagent", input: { description: "Checking the page in a browser" }, output: "Screenshots captured" },
  { tool: "webfetch", input: { url: "https://example.com/docs" }, output: "Fetched 18 KB" },
]

const REPLIES = [
  "Done. The change is local to this module and nothing else imports it, so the blast radius is small. Tests and typecheck pass.",
  "I found the cause: two code paths were writing the same field. They now go through one helper, with a test for the race.",
  "That's in. I also left a short note in the README so the next person knows why the flag exists.",
  "Typecheck passes and the build is green. I'll keep an eye on the next CI run and report back if anything regresses.",
]

let seq = 0
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`

export class DemoBackend implements Backend {
  readonly kind = "demo" as const
  private sessions = new Map<string, Session>()
  private msgs = new Map<string, Message[]>()
  private inboxes = new Map<string, InboxItem[]>()
  private perms = new Map<string, PermissionRequest[]>()
  private running = new Set<string>()
  private subs = new Set<(ev: OcEvent) => void>()
  private projects: Project[] = PROJECTS.map(([id, name]) => ({ id, name, canonical: `/Users/you/code/${name}` }))

  constructor() {
    const now = Date.now()
    for (const seed of SEEDS) {
      const id = uid("ses")
      const proj = this.projects.find((p) => p.id === seed.project)!
      const s: Session = {
        id,
        projectID: proj.id,
        agent: "build",
        model: { id: "demo-model", providerID: "demo" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        outcome: seed.running ? undefined : (seed.outcome ?? "succeeded"),
        time: {
          created: now - seed.ago - 20 * MIN,
          updated: now - seed.ago,
          ...(seed.running ? {} : { idle: now - seed.ago, viewed: seed.unseen ? now - seed.ago - 5 * MIN : now - seed.ago }),
        },
        title: seed.title,
        location: { directory: proj.canonical },
      }
      this.sessions.set(id, s)
      const t0 = s.time.created
      const assistant: Assistant = {
        type: "assistant",
        id: uid("msg"),
        time: { created: t0 + 2000, completed: s.time.updated },
        agent: "build",
        model: s.model!,
        content: [
          { type: "reasoning", text: "Looking at what changed since the last run.", time: { created: t0 + 2000, completed: t0 + 3000 } },
          ...SCRIPT.slice(0, 3 + (seed.title.length % 3)).map((st, i) => ({
            type: "tool" as const,
            id: uid("call"),
            name: st.tool,
            state: { status: "completed" as const, input: st.input, content: [{ type: "text", text: st.output }] },
            time: { created: t0 + 3000 + i * 1000, completed: t0 + 3500 + i * 1000 },
          })),
          { type: "text", text: seed.text },
        ],
      }
      const list: Message[] = [{ type: "user", id: uid("msg"), time: { created: t0 }, text: `Pick up "${seed.title}" where we left off.` }, assistant]
      this.msgs.set(id, list)
      for (let k = 0; k < (seed.subagents ?? 0); k++) {
        const cid = uid("ses")
        this.sessions.set(cid, {
          ...s,
          id: cid,
          parentID: id,
          agent: "explore",
          title: ["Search the codebase", "Run the browser checks", "Review the diff", "Read the docs", "Profile the hot path", "Write the tests"][k % 6],
          time: { created: t0 + 4000 + k, updated: s.time.updated - k * 1000 },
        })
        this.msgs.set(cid, [])
      }
      if (seed.running) {
        this.running.add(id)
        if (seed.user) {
          this.inboxes.set(id, [{ id: uid("msg"), sessionID: id, type: "user", payload: { text: seed.user }, delivery: "queue", time: { created: now } }])
        }
        const finishes = seed.title === "Nightly export to the warehouse"
        setTimeout(() => this.loop(id, !finishes), 400 + Math.random() * 2500)
      }
    }
    // One session blocked on a permission prompt.
    const blocked = [...this.sessions.values()].find((s) => s.title === "Refund webhooks")
    if (blocked)
      this.perms.set(blocked.id, [
        { id: uid("per"), sessionID: blocked.id, action: "shell", resources: ["git push origin feature/refund-webhooks"] },
      ])
  }

  // ---- event plumbing ----

  private emit(type: string, data: Record<string, any>) {
    const ev: OcEvent = { id: uid("evt"), type, created: Date.now(), data }
    for (const s of this.subs) s(ev)
  }

  subscribe(onEvent: (ev: OcEvent) => void, onState: (s: ConnectionState) => void) {
    this.subs.add(onEvent)
    setTimeout(() => {
      onState("demo")
      onEvent({ id: uid("evt"), type: "server.connected", data: {} })
    }, 0)
    return () => this.subs.delete(onEvent)
  }

  // ---- simulated work ----

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms))
  }

  private async loop(id: string, forever: boolean, replyTo?: string) {
    const s = this.sessions.get(id)
    if (!s) return
    this.running.add(id)
    this.emit("session.execution.started", { sessionID: id })
    let rounds = 0
    while (this.running.has(id)) {
      const m: Assistant = {
        type: "assistant",
        id: uid("msg"),
        time: { created: Date.now() },
        agent: "build",
        model: s.model!,
        content: [],
      }
      this.msgs.get(id)!.push(m)
      const aid = m.id
      this.emit("session.step.started", { sessionID: id, assistantMessageID: aid, agent: "build", model: s.model })

      this.emit("session.reasoning.started", { sessionID: id, assistantMessageID: aid, ordinal: 0 })
      m.content.push({ type: "reasoning", text: "", time: { created: Date.now() } })
      await this.sleep(900 + Math.random() * 900)
      ;(m.content[0] as any).time.completed = Date.now()
      this.emit("session.reasoning.ended", { sessionID: id, assistantMessageID: aid, ordinal: 0 })

      const tools = 1 + Math.floor(Math.random() * 3)
      for (let i = 0; i < tools && this.running.has(id); i++) {
        const st = SCRIPT[Math.floor(Math.random() * SCRIPT.length)]
        const call = uid("call")
        const part = { type: "tool" as const, id: call, name: st.tool, state: { status: "streaming" } as any, time: { created: Date.now() } }
        m.content.push(part)
        this.emit("session.tool.input.started", { sessionID: id, assistantMessageID: aid, id: call, name: st.tool })
        await this.sleep(250)
        part.state = { status: "running", input: st.input, metadata: {} }
        this.emit("session.tool.called", { sessionID: id, assistantMessageID: aid, id: call, input: st.input, executed: false })
        await this.sleep(900 + Math.random() * 1800)
        part.state = { status: "completed", input: st.input, content: [{ type: "text", text: st.output }] } as any
        this.emit("session.tool.success", { sessionID: id, assistantMessageID: aid, id: call, content: [{ type: "text", text: st.output }], executed: true })
      }
      if (!this.running.has(id)) break

      const reply = replyTo
        ? `On “${replyTo.slice(0, 60)}”: ${REPLIES[Math.floor(Math.random() * REPLIES.length)]}`
        : REPLIES[Math.floor(Math.random() * REPLIES.length)]
      replyTo = undefined
      const textPart = { type: "text" as const, text: "" }
      m.content.push(textPart)
      this.emit("session.text.started", { sessionID: id, assistantMessageID: aid, ordinal: 0 })
      for (const word of reply.split(/(?<= )/)) {
        if (!this.running.has(id)) break
        textPart.text += word
        this.emit("session.text.delta", { sessionID: id, assistantMessageID: aid, ordinal: 0, delta: word })
        await this.sleep(28 + Math.random() * 50)
      }
      this.emit("session.text.ended", { sessionID: id, assistantMessageID: aid, ordinal: 0 })
      m.time.completed = Date.now()
      m.finish = "stop"
      s.time.updated = Date.now()
      this.emit("session.step.ended", { sessionID: id, assistantMessageID: aid, finish: "stop" })
      rounds++

      // Deliver a queued message, if any, as the next turn.
      const queued = this.inboxes.get(id)?.shift()
      if (queued) {
        this.msgs.get(id)!.push({ type: "user", id: queued.id, time: { created: Date.now() }, text: queued.payload.text ?? "" })
        this.emit("session.inbox.delivered", { sessionID: id, inboxID: queued.id })
        replyTo = queued.payload.text
        continue
      }
      if (!forever || rounds > 50) break
      await this.sleep(2500 + Math.random() * 3000)
    }
    if (this.running.delete(id) || !forever) {
      s.outcome = "succeeded"
      s.time.updated = Date.now()
      s.time.idle = Date.now()
      this.emit("session.execution.succeeded", { sessionID: id })
    }
  }

  // ---- Backend ----

  async listProjects() {
    return this.projects
  }
  async listSessions() {
    return [...this.sessions.values()].map((s) => structuredClone(s))
  }
  async searchSessions(query: string) {
    const q = query.toLowerCase()
    return [...this.sessions.values()].filter((s) => (s.title ?? "").toLowerCase().includes(q)).map((s) => structuredClone(s))
  }
  async getSession(id: string) {
    const s = this.sessions.get(id)
    if (!s) throw new Error("Session not found")
    return structuredClone(s)
  }
  async active() {
    return new Set(this.running)
  }
  async messages(id: string, limit: number, cursor?: string): Promise<Page<Message>> {
    const all = this.msgs.get(id) ?? []
    const end = cursor ? Number(cursor) : all.length
    const start = Math.max(0, end - limit)
    return {
      data: structuredClone(all.slice(start, end)).reverse(),
      cursor: { next: start > 0 ? String(start) : null },
    }
  }
  async inbox(id: string) {
    return structuredClone(this.inboxes.get(id) ?? [])
  }
  async permissions(id: string) {
    return structuredClone(this.perms.get(id) ?? [])
  }
  async forms(_id: string): Promise<FormInfo[]> {
    return []
  }
  async listModels() {
    return [
      { id: "claude-sonnet-5-5", providerID: "anthropic", name: "Claude Sonnet 5.5" },
      { id: "claude-opus-5-5", providerID: "anthropic", name: "Claude Opus 5.5" },
      { id: "deepseek-v4.1-flash", providerID: "openrouter", name: "DeepSeek V4.1 Flash" },
      { id: "demo-model", providerID: "demo", name: "Demo model" },
    ]
  }
  async serverDefaultModel() {
    return { id: "demo-model", providerID: "demo", name: "Demo model" }
  }
  async listFolders(path: string) {
    if (path === "/Users/you" || path === "/Users/you/") return ["code", "Desktop", "Documents"]
    if (path.startsWith("/Users/you/code")) return this.projects.map((p) => p.canonical.split("/").pop()!).concat("new-idea")
    return []
  }
  async switchModel(id: string, model: ModelRef) {
    const s = this.sessions.get(id)
    if (s) s.model = model
    this.emit("session.model.selected", { sessionID: id, model })
  }
  async setSessionPermissions(id: string, rules: PermissionRule[] | null) {
    const s = this.sessions.get(id)
    if (s) s.permissions = rules
  }
  async createSession(directory: string, model?: ModelRef, permissions?: PermissionRule[]) {
    let proj = this.projects.find((p) => p.canonical === directory)
    if (!proj) {
      proj = { id: uid("p"), name: directory.split("/").filter(Boolean).pop() ?? directory, canonical: directory }
      this.projects.push(proj)
    }
    const now = Date.now()
    const s: Session = {
      id: uid("ses"),
      projectID: proj.id,
      agent: "build",
      model: model ?? { id: "demo-model", providerID: "demo" },
      permissions: permissions ?? null,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now },
      location: { directory: proj.canonical },
    }
    this.sessions.set(s.id, s)
    this.msgs.set(s.id, [])
    this.emit("session.created", { sessionID: s.id, projectID: s.projectID, location: s.location, model: s.model })
    return structuredClone(s)
  }
  async prompt(id: string, input: PromptInput) {
    const s = this.sessions.get(id)
    if (!s) throw new Error("Session not found")
    const item: InboxItem = { id: uid("msg"), sessionID: id, type: "user", payload: { text: input.text }, delivery: input.delivery ?? "steer" }
    this.emit("session.inbox.enqueued", { sessionID: id, inboxID: item.id, item })
    if (this.running.has(id) && input.delivery === "queue") {
      if (!this.inboxes.has(id)) this.inboxes.set(id, [])
      this.inboxes.get(id)!.push(item)
      return
    }
    this.msgs.get(id)!.push({ type: "user", id: item.id, time: { created: Date.now() }, text: input.text })
    this.emit("session.inbox.delivered", { sessionID: id, inboxID: item.id })
    if (!s.title) {
      s.title = input.text.slice(0, 48)
      setTimeout(() => this.emit("session.renamed", { sessionID: id, title: s.title }), 1200)
    }
    if (!this.running.has(id)) void this.loop(id, false, input.text)
  }
  async markViewed(id: string, idle: number) {
    const s = this.sessions.get(id)
    if (s) s.time.viewed = idle
  }
  async interrupt(id: string) {
    if (!this.running.delete(id)) return
    const s = this.sessions.get(id)
    if (s) {
      s.outcome = "interrupted"
      s.time.updated = Date.now()
      s.time.idle = Date.now()
    }
    this.emit("session.execution.interrupted", { sessionID: id })
  }
  async rename(id: string, title: string) {
    const s = this.sessions.get(id)
    if (s) s.title = title
    this.emit("session.renamed", { sessionID: id, title })
  }
  async setInboxDelivery(id: string, inboxID: string, delivery: Delivery) {
    const list = this.inboxes.get(id) ?? []
    const item = list.find((i) => i.id === inboxID)
    if (item) item.delivery = delivery
    this.emit("session.inbox.delivery.changed", { sessionID: id, inboxID, delivery })
  }
  async cancelInbox(id: string, inboxID: string) {
    this.inboxes.set(id, (this.inboxes.get(id) ?? []).filter((i) => i.id !== inboxID))
    this.emit("session.inbox.cancelled", { sessionID: id, inboxID })
  }
  async replyPermission(id: string, requestID: string, _decision: PermissionDecision) {
    this.perms.set(id, (this.perms.get(id) ?? []).filter((p) => p.id !== requestID))
    this.emit("permission.replied", { sessionID: id, requestID })
  }
  async replyForm() {}
  async cancelForm() {}
}
