// A session's live transcript: loads messages, patches them from the event
// stream as the agent works, and renders them (with inline permission and
// question prompts). Used by the open-session panel and by every tile.

import { attachmentSrc, type Backend } from "./backend"
import { describeTool, summarizeTools, toolOutput, toolRow, truncate } from "./format"
import { renderMarkdown } from "./markdown"
import { spinner } from "./spinners"
import type { Store } from "./store"
import { toast } from "./toast"
import type { AssistantPart, FileAttachment, FormField, FormInfo, InboxItem, Message, OcEvent, PermissionRequest } from "./types"

type ActivityItem =
  | { kind: "tool"; key: string; name: string; input?: Record<string, any>; status: string; output?: string }
  | { kind: "reasoning"; key: string; text: string; running: boolean }

type Block =
  | { kind: "user"; key: string; text: string; files: Array<{ src?: string; name?: string; mime: string }> }
  | { kind: "text"; key: string; text: string }
  | { kind: "activity"; key: string; items: ActivityItem[] }
  | { kind: "error"; key: string; text: string }
  | { kind: "shell"; key: string; command: string; output: string; status: string }
  | { kind: "divider"; key: string; text: string }
  | { kind: "inbox"; key: string; item: InboxItem }
  | { kind: "permission"; key: string; req: PermissionRequest; pending: number }
  | { kind: "form"; key: string; form: FormInfo }
  | { kind: "working"; key: string }

interface Rendered {
  sig: string
  el: HTMLElement
}


const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export interface TranscriptOptions {
  pageSize: number
  /** Tighter typography and no gutter column (tiles). */
  compact?: boolean
  /** After every render (header refresh etc). */
  onRender?: () => void
  /** The session finished a run while shown. */
  onFinished?: () => void
}

export class Transcript {
  readonly scroller: HTMLElement
  readonly list: HTMLElement
  private earlier: HTMLButtonElement

  id?: string
  messages: Message[] = []
  inbox: InboxItem[] = []
  private cursorOlder?: string | null
  private rendered = new Map<string, Rendered>()
  private expanded = new Set<string>()
  private refetchTimer?: ReturnType<typeof setTimeout>
  private renderQueued = false
  private loadSeq = 0
  private off: () => void

  constructor(
    private store: Store,
    private backend: Backend,
    private opts: TranscriptOptions,
  ) {
    this.scroller = h("div", `transcript-scroll${opts.compact ? " compact" : ""}`)
    this.earlier = h("button", "earlier", "Load earlier messages") as HTMLButtonElement
    this.earlier.hidden = true
    this.earlier.addEventListener("click", () => this.loadOlder())
    this.list = h("div", `transcript${opts.compact ? " compact" : ""}`)
    this.scroller.append(this.earlier, this.list)
    this.scroller.addEventListener("scroll", () => {
      if (this.scroller.scrollTop < 40 && this.cursorOlder) void this.loadOlder()
    })
    this.off = store.on({
      event: (ev) => this.onEvent(ev),
      cards: (ids) => {
        if (this.id && ids.has(this.id)) this.queueRender()
      },
    })
  }

  /** Show a session (or nothing). Resets state and loads the latest page. */
  setSession(id: string | undefined) {
    this.id = id
    this.messages = []
    this.inbox = []
    this.cursorOlder = undefined
    this.rendered.clear()
    this.expanded.clear()
    this.list.replaceChildren()
    this.earlier.hidden = true
    if (this.refetchTimer) clearTimeout(this.refetchTimer)
    this.refetchTimer = undefined
    if (id) {
      this.queueRender()
      void this.load(true)
    }
  }

  /** Show a message as pending until the server confirms it. */
  addPending(item: InboxItem) {
    this.inbox = [...this.inbox, item]
    this.render(true)
  }

  removePending(item: InboxItem) {
    this.inbox = this.inbox.filter((i) => i !== item)
    this.render(false)
  }

  destroy() {
    this.off()
    if (this.refetchTimer) clearTimeout(this.refetchTimer)
    this.id = undefined
  }

  async load(scrollToEnd: boolean) {
    const id = this.id
    if (!id) return
    const seq = ++this.loadSeq
    try {
      const [page, inbox] = await Promise.all([
        this.backend.messages(id, this.opts.pageSize),
        this.backend.inbox(id).catch(() => [] as InboxItem[]),
      ])
      if (seq !== this.loadSeq || id !== this.id) return
      const latest = [...page.data].reverse()
      // Keep any older pages already loaded above the newest page.
      if (this.messages.length > latest.length && latest.length) {
        const firstNew = latest[0].id
        const idx = this.messages.findIndex((m) => m.id === firstNew)
        this.messages = idx >= 0 ? [...this.messages.slice(0, idx), ...latest] : latest
      } else {
        this.messages = latest
        this.cursorOlder = page.data.length >= this.opts.pageSize ? page.cursor?.next : undefined
      }
      this.inbox = inbox
      this.render(scrollToEnd)
    } catch (e) {
      if (id === this.id) toast(`Couldn't load session: ${(e as Error).message}`)
    }
  }

  private async loadOlder() {
    const id = this.id
    const cursor = this.cursorOlder
    if (!id || !cursor) return
    this.cursorOlder = undefined
    this.earlier.textContent = "Loading…"
    try {
      const page = await this.backend.messages(id, this.opts.pageSize, cursor)
      if (id !== this.id) return
      const before = this.scroller.scrollHeight
      const older = [...page.data].reverse().filter((m) => !this.messages.some((x) => x.id === m.id))
      this.messages = [...older, ...this.messages]
      this.cursorOlder = page.data.length >= this.opts.pageSize ? page.cursor?.next : undefined
      this.render(false)
      this.scroller.scrollTop += this.scroller.scrollHeight - before
    } finally {
      this.earlier.textContent = "Load earlier messages"
    }
  }

  scheduleRefetch(delay = 450) {
    if (this.refetchTimer) return
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = undefined
      void this.load(false)
    }, delay)
  }

  // ---- live events --------------------------------------------------------------

  private assistant(id: string): Extract<Message, { type: "assistant" }> {
    let m = this.messages.find((x) => x.id === id) as Extract<Message, { type: "assistant" }> | undefined
    if (!m) {
      m = { type: "assistant", id, time: { created: Date.now() }, agent: "", model: { id: "", providerID: "" }, content: [] }
      this.messages.push(m)
    }
    return m
  }

  private nthPart(m: Extract<Message, { type: "assistant" }>, type: "text" | "reasoning", ordinal: number) {
    let n = -1
    for (const p of m.content) if (p.type === type && ++n === ordinal) return p as Extract<AssistantPart, { type: "text" | "reasoning" }>
    const part = { type, text: "" } as Extract<AssistantPart, { type: "text" | "reasoning" }>
    m.content.push(part)
    return part
  }

  private toolPart(m: Extract<Message, { type: "assistant" }>, callID: string, name?: string) {
    let p = m.content.find((x) => x.type === "tool" && x.id === callID) as Extract<AssistantPart, { type: "tool" }> | undefined
    if (!p) {
      p = { type: "tool", id: callID, name: name ?? "tool", state: { status: "streaming" }, time: { created: Date.now() } }
      m.content.push(p)
    }
    if (name) p.name = name
    return p
  }

  private onEvent(ev: OcEvent) {
    const id = this.id
    if (!id || ev.data?.sessionID !== id) return
    const d = ev.data
    switch (ev.type) {
      case "session.step.started": {
        const m = this.assistant(d.assistantMessageID)
        m.agent = d.agent ?? m.agent
        m.model = d.model ?? m.model
        break
      }
      case "session.text.started":
        this.nthPart(this.assistant(d.assistantMessageID), "text", d.ordinal ?? 0)
        break
      case "session.text.delta":
        this.nthPart(this.assistant(d.assistantMessageID), "text", d.ordinal ?? 0).text += d.delta ?? ""
        break
      case "session.reasoning.started":
        this.nthPart(this.assistant(d.assistantMessageID), "reasoning", d.ordinal ?? 0)
        break
      case "session.reasoning.delta":
        this.nthPart(this.assistant(d.assistantMessageID), "reasoning", d.ordinal ?? 0).text += d.delta ?? ""
        break
      case "session.tool.input.started":
        this.toolPart(this.assistant(d.assistantMessageID), d.id, d.name)
        break
      case "session.tool.called": {
        const p = this.toolPart(this.assistant(d.assistantMessageID), d.id)
        p.state = { status: "running", input: d.input, metadata: {} }
        break
      }
      case "session.tool.success": {
        const p = this.toolPart(this.assistant(d.assistantMessageID), d.id)
        p.state = { status: "completed", input: p.state.input, content: d.content, metadata: d.metadata }
        break
      }
      case "session.tool.failed": {
        const p = this.toolPart(this.assistant(d.assistantMessageID), d.id)
        p.state = { status: "error", input: p.state.input, error: d.error ?? d.message ?? "Tool failed" }
        break
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        this.opts.onFinished?.()
        this.scheduleRefetch(300)
        break
      case "session.inbox.enqueued":
      case "session.inbox.delivered":
      case "session.inbox.cancelled":
      case "session.inbox.delivery.changed":
      case "session.step.ended":
      case "session.execution.started":
      case "session.shell.started":
      case "session.shell.ended":
      case "session.compaction.ended":
      case "session.model.selected":
      case "session.agent.selected":
      case "session.synthetic":
        this.scheduleRefetch(ev.type === "session.inbox.enqueued" ? 60 : 300)
        break
      case "session.renamed":
        this.opts.onRender?.()
        return
      default:
        if (!ev.type.startsWith("permission.") && !ev.type.startsWith("form.") && !ev.type.startsWith("question.")) return
    }
    this.queueRender()
  }

  queueRender() {
    if (this.renderQueued) return
    this.renderQueued = true
    requestAnimationFrame(() => {
      this.renderQueued = false
      this.render(false)
    })
  }

  private blocks(): Block[] {
    const out: Block[] = []
    let act: Extract<Block, { kind: "activity" }> | undefined
    const flush = () => {
      if (act?.items.length) out.push(act)
      act = undefined
    }
    const activity = (key: string) => (act ??= { kind: "activity", key: `act:${key}`, items: [] })

    for (const m of this.messages) {
      switch (m.type) {
        case "user":
          flush()
          out.push({
            kind: "user",
            key: m.id,
            text: m.text,
            files: (m.files ?? []).map((f: FileAttachment) => ({ src: attachmentSrc(f), name: f.name, mime: f.mime })),
          })
          break
        case "assistant":
          m.content.forEach((p, i) => {
            const key = `${m.id}:${i}`
            if (p.type === "text") {
              if (!p.text.trim()) return
              flush()
              out.push({ kind: "text", key, text: p.text })
            } else if (p.type === "reasoning") {
              if (!p.text.trim() && p.time?.completed) return
              activity(key).items.push({ kind: "reasoning", key, text: p.text, running: !p.time?.completed && !m.time.completed })
            } else {
              activity(key).items.push({
                kind: "tool",
                key: `${key}:${p.id}`,
                name: p.name,
                input: p.state.input,
                status: p.state.status,
                output: p.state.status === "completed" || p.state.status === "error" ? toolOutput(p.state) : undefined,
              })
            }
          })
          if (m.error) {
            flush()
            out.push({ kind: "error", key: `${m.id}:error`, text: m.error.message ?? m.error.type ?? JSON.stringify(m.error) })
          }
          break
        case "shell":
          flush()
          out.push({ kind: "shell", key: m.id, command: m.command, output: m.output?.output ?? "", status: m.status })
          break
        case "compaction":
          flush()
          out.push({ kind: "divider", key: m.id, text: "Context compacted" })
          break
        case "model-switched": {
          const model = (m as any).model
          if (model?.id) out.push({ kind: "divider", key: m.id, text: `Switched to ${model.id}` })
          break
        }
        case "agent-switched": {
          const agent = (m as any).agent
          if (agent) out.push({ kind: "divider", key: m.id, text: `Switched to ${typeof agent === "string" ? agent : agent.name ?? "agent"}` })
          break
        }
      }
    }
    flush()

    const id = this.id!
    for (const item of this.inbox) out.push({ kind: "inbox", key: `inbox:${item.id}`, item })
    for (const req of this.store.permissions.get(id) ?? []) out.push({ kind: "permission", key: `perm:${req.id}`, req, pending: this.store.pendingPermissionCount() })
    for (const form of this.store.forms.get(id) ?? []) out.push({ kind: "form", key: `form:${form.id}`, form })
    // A live tool row already says what's happening; don't repeat it.
    const last = [...out].reverse().find((b) => b.kind !== "inbox")
    const liveActivity =
      last?.kind === "activity" &&
      last.items.some((i) => (i.kind === "tool" ? i.status === "running" || i.status === "streaming" : i.running))
    if (this.store.running.has(id) && !this.store.needsInput(id) && !liveActivity) out.push({ kind: "working", key: "working" })
    return out
  }

  render(scrollToEnd: boolean) {
    if (!this.id) return
    const nearEnd = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 90
    const blocks = this.blocks()
    const keep = new Set<string>()
    let prev: Element | null = null
    for (const b of blocks) {
      keep.add(b.key)
      const sig = b.kind === "working" ? "w" : JSON.stringify(b) + (this.expanded.has(b.key) ? "+" : "")
      let r = this.rendered.get(b.key)
      if (!r || r.sig !== sig) {
        const el = this.renderBlock(b)
        if (r) r.el.replaceWith(el)
        r = { sig, el }
        this.rendered.set(b.key, r)
      }
      const want: Element | null = prev ? prev.nextElementSibling : this.list.firstElementChild
      if (want !== r.el) this.list.insertBefore(r.el, want)
      prev = r.el
    }
    for (const [k, r] of this.rendered) {
      if (keep.has(k)) continue
      r.el.remove()
      this.rendered.delete(k)
    }
    const working = this.rendered.get("working")
    if (working) {
      const label = working.el.querySelector(".label")
      if (label) label.textContent = this.store.activityLabel(this.id)
    }
    this.earlier.hidden = !this.cursorOlder
    this.opts.onRender?.()
    if (scrollToEnd || nearEnd) this.scroller.scrollTop = this.scroller.scrollHeight
  }

  private renderBlock(b: Block): HTMLElement {
    switch (b.kind) {
      case "user": {
        const row = h("div", "msg user")
        row.append(h("div", "gutter", "You"))
        const body = h("div", "body")
        body.append(h("div", "user-text", b.text))
        for (const f of b.files) {
          if (f.src && f.mime.startsWith("image/")) {
            const img = h("img", "attachment") as HTMLImageElement
            img.src = f.src
            img.alt = f.name ?? "image"
            img.loading = "lazy"
            body.append(img)
          } else body.append(h("div", "file-chip", f.name ?? f.mime))
        }
        row.append(body)
        return row
      }
      case "text": {
        const row = h("div", "msg assistant")
        row.append(h("div", "gutter"))
        const body = h("div", "body md")
        body.innerHTML = renderMarkdown(b.text)
        row.append(body)
        return row
      }
      case "activity":
        return this.renderActivity(b)
      case "error": {
        const row = h("div", "msg error")
        row.append(h("div", "gutter"), h("div", "body", b.text))
        return row
      }
      case "shell": {
        const row = h("div", "msg shell")
        row.append(h("div", "gutter", "Shell"))
        const body = h("div", "body")
        body.append(h("div", "shell-cmd", `$ ${b.command}`))
        if (b.output) body.append(h("pre", "tool-output", truncate(b.output, 4000)))
        row.append(body)
        return row
      }
      case "divider":
        return h("div", "divider", b.text)
      case "inbox":
        return this.renderInbox(b.item)
      case "permission":
        return this.renderPermission(b.req)
      case "form":
        return this.renderForm(b.form)
      case "working": {
        const row = h("div", "msg working")
        row.append(h("div", "gutter"))
        const body = h("div", "body")
        body.append(spinner(16), h("span", "label", "Working…"))
        row.append(body)
        return row
      }
    }
  }

  private renderActivity(b: Extract<Block, { kind: "activity" }>) {
    const row = h("div", "msg activity")
    row.append(h("div", "gutter"))
    const body = h("div", "body")
    const tools = b.items.filter((i): i is Extract<ActivityItem, { kind: "tool" }> => i.kind === "tool")
    const running = b.items.some((i) => (i.kind === "tool" ? i.status === "running" || i.status === "streaming" : i.running))
    const open = this.expanded.has(b.key)
    const head = h("button", "activity-head")
    head.setAttribute("aria-expanded", String(open))
    if (running) head.append(spinner(12))
    else head.append(h("span", "twisty", open ? "–" : "+"))
    let summary = summarizeTools(tools)
    if (running) {
      const live = [...tools].reverse().find((t) => t.status === "running" || t.status === "streaming")
      summary = live ? describeTool(live.name, live.input) : "Thinking…"
    }
    head.append(h("span", "summary", summary || "Thought"))
    head.addEventListener("click", () => {
      if (this.expanded.has(b.key)) this.expanded.delete(b.key)
      else this.expanded.add(b.key)
      this.queueRender()
    })
    body.append(head)
    if (open) {
      const listEl = h("div", "activity-list")
      for (const it of b.items) {
        if (it.kind === "reasoning") {
          if (!it.text.trim()) continue
          const r = h("div", "activity-row reasoning")
          r.append(h("span", "verb", "Thought"), h("span", "target", truncate(it.text, 160)))
          r.addEventListener("click", () => r.classList.toggle("open"))
          const full = h("div", "reasoning-text", it.text)
          listEl.append(r, full)
          continue
        }
        const [verb, target] = toolRow(it.name, it.input)
        const r = h("div", `activity-row ${it.status}`)
        r.append(h("span", "verb", verb), h("span", "target", target))
        listEl.append(r)
        if (it.output) {
          const pre = h("pre", "tool-output", truncate(it.output, 6000))
          pre.hidden = true
          r.classList.add("expandable")
          r.addEventListener("click", () => {
            pre.hidden = !pre.hidden
            r.classList.toggle("open", !pre.hidden)
          })
          listEl.append(pre)
        }
      }
      body.append(listEl)
    }
    row.append(body)
    return row
  }

  private renderInbox(item: InboxItem) {
    const row = h("div", `msg inbox ${item.delivery}`)
    row.append(h("div", "gutter", item.delivery === "queue" ? "Queued" : "Steering"))
    const body = h("div", "body")
    body.append(h("div", "user-text", item.payload?.text ?? `(${item.type})`))
    const actions = h("div", "inbox-actions")
    if (item.delivery === "queue") {
      const steer = h("button", "link", "Send now") as HTMLButtonElement
      steer.addEventListener("click", () => this.act(() => this.backend.setInboxDelivery(item.sessionID, item.id, "steer")))
      actions.append(steer)
    }
    const cancel = h("button", "link", "Cancel") as HTMLButtonElement
    cancel.addEventListener("click", () => this.act(() => this.backend.cancelInbox(item.sessionID, item.id)))
    actions.append(cancel)
    body.append(actions)
    row.append(body)
    return row
  }

  private renderPermission(req: PermissionRequest) {
    const row = h("div", "msg ask")
    row.append(h("div", "gutter", "Permission"))
    const body = h("div", "body")
    body.append(h("div", "ask-title", `Allow ${req.action}?`))
    if (req.resources?.length) {
      const res = h("div", "ask-resources")
      for (const r of req.resources.slice(0, 6)) res.append(h("code", "", r))
      if (req.resources.length > 6) res.append(h("span", "dim", `+${req.resources.length - 6} more`))
      body.append(res)
    }
    const actions = h("div", "ask-actions")
    const btn = (label: string, decision: "once" | "always" | "reject", cls = "") => {
      const b = h("button", `btn ${cls}`, label) as HTMLButtonElement
      b.addEventListener("click", () =>
        this.act(async () => {
          await this.backend.replyPermission(req.sessionID, req.id, decision)
          this.store.permissions.set(
            req.sessionID,
            (this.store.permissions.get(req.sessionID) ?? []).filter((p) => p.id !== req.id),
          )
          this.store.touchCard(req.sessionID)
        }),
      )
      return b
    }
    const everything = h("button", "btn allow-all", "Allow everything in this session") as HTMLButtonElement
    everything.title = "Approve this and every future request in this session (saved on the OpenCode server)"
    everything.addEventListener("click", () =>
      this.act(async () => {
        await this.store.setSessionAutoApprove(req.sessionID, true)
        toast("This session won't ask again")
      }),
    )
    actions.append(btn("Allow once", "once", "primary"), btn("Always allow", "always"), everything, btn("Reject", "reject", "ghost"))
    const pending = this.store.pendingPermissionCount()
    if (pending > 1) {
      const all = h("button", "link allow-pending", `Allow all ${pending} waiting requests`) as HTMLButtonElement
      all.addEventListener("click", () =>
        this.act(async () => {
          const n = await this.store.approveAllPending()
          toast(`Approved ${n} request${n === 1 ? "" : "s"}`)
        }),
      )
      actions.append(all)
    }
    body.append(actions)
    row.append(body)
    return row
  }

  private renderForm(form: FormInfo) {
    const row = h("div", "msg ask")
    row.append(h("div", "gutter", "Question"))
    const body = h("form", "body ask-form") as HTMLFormElement
    body.append(h("div", "ask-title", form.title))
    const getters: Array<[FormField, () => unknown]> = []
    for (const f of form.fields) {
      if (f.hidden) continue
      const field = h("label", "field")
      if (f.title) field.append(h("span", "field-title", f.title))
      if (f.description) field.append(h("span", "field-desc", f.description))
      if (f.type === "boolean") {
        const cb = h("input") as HTMLInputElement
        cb.type = "checkbox"
        cb.checked = !!f.default
        field.classList.add("inline")
        field.prepend(cb)
        getters.push([f, () => cb.checked])
      } else if (f.type === "multiselect") {
        const boxes: HTMLInputElement[] = []
        for (const o of f.options ?? []) {
          const l = h("label", "opt")
          const cb = h("input") as HTMLInputElement
          cb.type = "checkbox"
          cb.value = o.value
          cb.checked = Array.isArray(f.default) && f.default.includes(o.value)
          boxes.push(cb)
          l.append(cb, document.createTextNode(" " + o.label))
          field.append(l)
        }
        getters.push([f, () => boxes.filter((b) => b.checked).map((b) => b.value)])
      } else if (f.type === "string" && f.options?.length && !f.custom) {
        const sel = h("select") as HTMLSelectElement
        for (const o of f.options) {
          const opt = h("option", "", o.label) as HTMLOptionElement
          opt.value = o.value
          sel.append(opt)
        }
        if (f.default) sel.value = f.default
        field.append(sel)
        getters.push([f, () => sel.value])
      } else if (f.type === "external") {
        field.append(h("span", "dim", "Answer this one in OpenCode."))
      } else {
        const inp = h("input") as HTMLInputElement
        inp.type = f.type === "number" || f.type === "integer" ? "number" : "text"
        if (f.type === "integer") inp.step = "1"
        inp.placeholder = f.placeholder ?? ""
        if (f.default !== undefined) inp.value = String(f.default)
        inp.required = !!f.required
        field.append(inp)
        getters.push([f, () => (inp.type === "number" ? (inp.value === "" ? undefined : Number(inp.value)) : inp.value)])
      }
      body.append(field)
    }
    const actions = h("div", "ask-actions")
    const submit = h("button", "btn primary", "Answer") as HTMLButtonElement
    submit.type = "submit"
    const cancel = h("button", "btn ghost", "Dismiss") as HTMLButtonElement
    cancel.type = "button"
    cancel.addEventListener("click", () => this.act(() => this.backend.cancelForm(form.sessionID, form.id)))
    actions.append(submit, cancel)
    body.append(actions)
    body.addEventListener("submit", (e) => {
      e.preventDefault()
      const answer: Record<string, unknown> = {}
      for (const [f, get] of getters) {
        const v = get()
        if (v !== undefined && v !== "") answer[f.key] = v
      }
      void this.act(() => this.backend.replyForm(form.sessionID, form.id, answer))
    })
    row.append(body)
    return row
  }

  async act(fn: () => Promise<unknown>) {
    try {
      await fn()
      this.scheduleRefetch(50)
    } catch (e) {
      toast((e as Error).message)
    }
  }
}
