// The open session: expands out of its card, streams the transcript live,
// and steers or queues new input.

import type { Backend } from "./backend"
import type { CanvasView } from "./canvas"
import { basename, timeAgo } from "./format"
import { defaultModel, modelLabel, models, setDefaultModel } from "./models"
import { spinner } from "./spinners"
import type { Store } from "./store"
import { toast } from "./toast"
import { Transcript } from "./transcript"
import type { InboxItem } from "./types"

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}


export class SessionPanel {
  readonly el: HTMLElement
  private scrim: HTMLElement
  private header: HTMLElement
  private projectEl: HTMLElement
  private statusEl: HTMLElement
  private modelBtn: HTMLButtonElement
  private autoBadge: HTMLElement
  private subBtn: HTMLButtonElement
  private stopBtn: HTMLButtonElement
  private menuBtn: HTMLButtonElement
  private titleEl: HTMLElement
  private line: HTMLElement
  private transcript: Transcript
  private input: HTMLTextAreaElement
  private hint: HTMLElement
  private attachRow: HTMLElement
  private popover?: HTMLElement

  id?: string
  /** Set by the app once the tiled view exists. */
  tiles?: { isPinned(id: string): boolean; togglePin(id: string): void }
  private attachments: Array<{ uri: string; name: string }> = []
  private closing = false
  private statusState = ""

  constructor(
    private host: HTMLElement,
    private store: Store,
    private backend: Backend,
    private canvas: CanvasView,
    private onClosed: () => void,
  ) {
    this.scrim = h("div", "scrim")
    this.scrim.addEventListener("pointerdown", () => this.close())
    this.el = h("section", "panel")
    this.el.setAttribute("role", "dialog")
    this.el.setAttribute("aria-modal", "false")

    this.header = h("header", "panel-head")
    const left = h("div", "head-left")
    this.projectEl = h("span", "head-project")
    this.statusEl = h("span", "head-status")
    this.modelBtn = h("button", "head-btn model") as HTMLButtonElement
    this.modelBtn.title = "Switch model"
    this.modelBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      void this.toggleModels()
    })
    this.autoBadge = h("span", "auto-badge", "Auto-approve")
    this.autoBadge.hidden = true
    left.append(this.projectEl, this.statusEl, this.modelBtn, this.autoBadge)
    const right = h("div", "head-right")
    this.subBtn = h("button", "head-btn subagents") as HTMLButtonElement
    this.subBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      this.toggleSubagents()
    })
    this.stopBtn = h("button", "head-btn stop", "Stop") as HTMLButtonElement
    this.stopBtn.title = "Interrupt (⌘.)"
    this.stopBtn.addEventListener("click", () => this.interrupt())
    this.menuBtn = h("button", "head-btn menu", "⋯") as HTMLButtonElement
    this.menuBtn.setAttribute("aria-label", "Session menu")
    this.menuBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      this.toggleMenu()
    })
    right.append(this.subBtn, this.stopBtn, this.menuBtn)
    this.header.append(left, right)

    this.titleEl = h("h1", "panel-title")
    this.titleEl.title = "Double-click to rename"
    this.titleEl.addEventListener("dblclick", () => this.beginRename())
    this.line = h("div", "panel-line")

    this.transcript = new Transcript(store, backend, {
      pageSize: 80,
      onRender: () => this.renderHeader(),
      // You watched it finish: that counts as reviewed.
      onFinished: () => {
        if (this.id && !this.closing) this.store.markViewed(this.id)
      },
    })
    this.transcript.scroller.classList.add("panel-scroll")

    const composer = h("div", "composer")
    this.attachRow = h("div", "attachments")
    const row = h("div", "composer-row")
    this.input = h("textarea", "composer-input") as HTMLTextAreaElement
    this.input.rows = 1
    this.input.spellcheck = true
    this.hint = h("span", "composer-hint")
    row.append(this.input, this.hint)
    composer.append(this.attachRow, row)
    this.bindComposer()

    this.el.append(this.header, this.titleEl, this.line, this.transcript.scroller, composer)
    this.el.addEventListener("pointerdown", () => this.closePopover())
    host.append(this.scrim, this.el)

    store.on({
      cards: (ids) => {
        if (this.id && ids.has(this.id)) this.renderHeader()
      },
      event: (ev) => {
        const d: any = ev.data ?? {}
        if (ev.type === "session.created" && d.draftId && this.id === d.draftId && d.sessionID && d.sessionID !== d.draftId) {
          this.open(d.sessionID)
        }
        if (ev.type === "session.execution.failed" && this.id && d.sessionID === this.id && d.error) {
          toast(`Failed: ${String(d.error).slice(-280)}`)
        }
      },
    })
    window.addEventListener("resize", () => {
      if (this.id && !this.closing) this.applyGeometry(this.targetRect(), false)
    })
  }

  get isOpen() {
    return !!this.id && !this.closing
  }

  // ---- open / close -----------------------------------------------------------

  private targetRect() {
    const vw = innerWidth
    const vh = innerHeight
    const w = Math.min(860, vw - 32)
    const top = vw < 640 ? 12 : 24
    const bottom = vw < 640 ? 64 : 74
    return new DOMRect((vw - w) / 2, top, w, vh - top - bottom)
  }

  private applyGeometry(r: DOMRect, animate: boolean) {
    this.el.classList.toggle("animating", animate)
    Object.assign(this.el.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    })
  }

  open(id: string, from?: DOMRect) {
    const switching = this.isOpen
    this.id = id
    this.closing = false
    this.attachments = []
    this.renderAttachments()
    this.statusState = ""
    this.closePopover()
    this.canvas.setOpen(id)
    this.store.markViewed(id)
    this.renderHeader()

    if (!switching) {
      this.el.classList.add("visible")
      this.scrim.classList.add("visible")
      this.el.classList.add("entering")
      const target = this.targetRect()
      this.applyGeometry(from ?? new DOMRect(target.left + target.width / 2 - 150, target.top + 80, 300, 200), false)
      void this.el.offsetWidth
      this.applyGeometry(target, true)
      setTimeout(() => this.el.classList.remove("entering"), 90)
    }
    this.transcript.setSession(id)
    setTimeout(() => {
      if (this.id === id && !matchMedia("(pointer: coarse)").matches) this.input.focus({ preventScroll: true })
    }, switching ? 0 : 260)
  }

  close() {
    if (!this.id || this.closing) return
    const id = this.id
    this.closing = true
    this.closePopover()
    this.input.blur()
    const rect = this.canvas.cardRect(id)
    this.el.classList.add("leaving")
    this.scrim.classList.remove("visible")
    if (rect) this.applyGeometry(rect, true)
    const done = () => {
      if (!this.closing) return
      this.el.classList.remove("visible", "leaving", "animating")
      this.canvas.setOpen(undefined)
      this.id = undefined
      this.transcript.setSession(undefined)
      this.closing = false
      this.onClosed()
    }
    setTimeout(done, rect ? 380 : 120)
  }

  // ---- rendering ----------------------------------------------------------------

  private renderHeader() {
    const id = this.id
    const s = id ? this.store.sessions.get(id) : undefined
    if (!id || !s) return
    this.projectEl.textContent = this.store.projectLabel(s)
    this.projectEl.title = s.location.directory
    const working = this.store.running.has(id)
    const ask = this.store.needsInput(id)
    const state = ask ? `ask:${ask}` : working ? "working" : "idle"
    if (state !== this.statusState) {
      this.statusState = state
      this.statusEl.replaceChildren()
      if (ask) this.statusEl.append(h("span", "mark needs-you"), h("span", "label", ask === "permission" ? "Needs permission" : "Waiting for your answer"))
      else if (working) this.statusEl.append(spinner(13), h("span", "label"))
      else {
        const st = s.outcome === "failed" ? "failed" : s.outcome === "interrupted" ? "stopped" : "done"
        this.statusEl.append(h("span", `mark ${st}`), h("span", "label"))
      }
      this.el.dataset.status = ask ? "needs-you" : working ? "working" : (s.outcome ?? "done")
    }
    const label = this.statusEl.querySelector(".label")
    if (label && !ask)
      label.textContent = working
        ? this.store.activityLabel(id)
        : `${s.outcome === "failed" ? "Failed" : s.outcome === "interrupted" ? "Stopped" : "Done"} · ${timeAgo(s.time.idle ?? s.time.updated)}`
    this.el.classList.toggle("working", working)
    this.modelBtn.textContent = modelLabel(s.model)
    const auto = this.store.autoApproveAll || this.store.sessionAutoApproves(id)
    this.autoBadge.hidden = !auto
    this.autoBadge.title = this.store.sessionAutoApproves(id)
      ? "This session never asks for permission (⋯ menu to change)"
      : "Auto-approve is on for every session (top bar to change)"
    this.stopBtn.hidden = !working
    const n = this.store.subagentCount(id)
    this.subBtn.hidden = n === 0
    this.subBtn.textContent = `${n} subagent${n === 1 ? "" : "s"}`
    if (document.activeElement !== this.titleEl) this.titleEl.textContent = this.store.title(s)
    this.input.placeholder = working ? "Steer…" : this.transcript.messages.length ? "Reply…" : "Ask anything…"
    this.hint.textContent = working ? "Tab to queue" : ""
    this.hint.hidden = !working
  }


  // ---- header actions -----------------------------------------------------------

  private async interrupt() {
    if (!this.id) return
    await this.transcript.act(() => this.backend.interrupt(this.id!))
  }

  private beginRename() {
    const id = this.id
    if (!id) return
    const t = this.titleEl
    t.contentEditable = "plaintext-only"
    t.focus()
    document.getSelection()?.selectAllChildren(t)
    const finish = (commit: boolean) => {
      t.contentEditable = "false"
      t.removeEventListener("keydown", onKey)
      t.removeEventListener("blur", onBlur)
      const title = t.textContent?.trim() ?? ""
      const s = this.store.sessions.get(id)
      if (commit && s && title && title !== s.title) {
        s.title = title
        this.store.markStructure()
        void this.transcript.act(() => this.backend.rename(id, title))
      }
      this.renderHeader()
    }
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === "Enter") {
        e.preventDefault()
        finish(true)
      } else if (e.key === "Escape") {
        e.preventDefault()
        finish(false)
      }
    }
    const onBlur = () => finish(true)
    t.addEventListener("keydown", onKey)
    t.addEventListener("blur", onBlur)
  }

  private closePopover() {
    this.popover?.remove()
    this.popover = undefined
  }

  private showPopover(anchor: HTMLElement, items: Array<{ label: string; sub?: string; run: () => void; working?: boolean }>) {
    this.closePopover()
    const pop = h("div", "popover")
    for (const it of items) {
      const b = h("button", "pop-item") as HTMLButtonElement
      if (it.working) b.append(spinner(12))
      b.append(h("span", "pop-label", it.label))
      if (it.sub) b.append(h("span", "pop-sub", it.sub))
      b.addEventListener("click", (e) => {
        e.stopPropagation()
        this.closePopover()
        it.run()
      })
      pop.append(b)
    }
    pop.addEventListener("pointerdown", (e) => e.stopPropagation())
    const r = anchor.getBoundingClientRect()
    const pr = this.el.getBoundingClientRect()
    pop.style.top = `${r.bottom - pr.top + 6}px`
    pop.style.right = `${pr.right - r.right}px`
    this.el.append(pop)
    this.popover = pop
  }

  private toggleSubagents() {
    if (this.popover) return this.closePopover()
    const id = this.id
    if (!id) return
    const kids = [...(this.store.children.get(id) ?? [])]
      .map((k) => this.store.sessions.get(k)!)
      .filter(Boolean)
      .sort((a, b) => b.time.updated - a.time.updated)
    this.showPopover(
      this.subBtn,
      kids.map((k) => ({
        label: this.store.title(k),
        sub: this.store.running.has(k.id) ? this.store.activityLabel(k.id) : `${k.agent ?? "subagent"} · ${timeAgo(k.time.updated)}`,
        working: this.store.running.has(k.id),
        run: () => this.open(k.id),
      })),
    )
  }

  private async toggleModels() {
    if (this.popover) return this.closePopover()
    const id = this.id
    const s = id ? this.store.sessions.get(id) : undefined
    if (!id || !s) return
    const pop = h("div", "popover models")
    const filter = h("input", "pop-filter") as HTMLInputElement
    filter.placeholder = "Search models"
    filter.spellcheck = false
    const list = h("div", "pop-list")
    pop.append(filter, list)
    pop.addEventListener("pointerdown", (e) => e.stopPropagation())
    const r = this.modelBtn.getBoundingClientRect()
    const pr = this.el.getBoundingClientRect()
    pop.style.top = `${r.bottom - pr.top + 6}px`
    pop.style.left = `${Math.max(12, r.left - pr.left)}px`
    this.closePopover()
    this.el.append(pop)
    this.popover = pop
    list.append(h("div", "pop-empty", "Loading models…"))
    let all: Awaited<ReturnType<typeof models>>
    try {
      all = await models(this.backend)
    } catch (e) {
      list.replaceChildren(h("div", "pop-empty", `Couldn't list models: ${(e as Error).message}`))
      return
    }
    if (this.popover !== pop) return
    const current = s.model ? `${s.model.providerID}/${s.model.id}` : ""
    const pinned = defaultModel()
    const draw = () => {
      const q = filter.value.toLowerCase().split(/\s+/).filter(Boolean)
      const hits = all
        .filter((m) => {
          const hay = `${m.providerID}/${m.id} ${m.name}`.toLowerCase()
          return q.every((t) => hay.includes(t))
        })
        .slice(0, 80)
      list.replaceChildren(
        ...hits.map((m) => {
          const key = `${m.providerID}/${m.id}`
          const b = h("button", `pop-item${key === current ? " current" : ""}`) as HTMLButtonElement
          b.append(h("span", "pop-label", m.name), h("span", "pop-sub", key + (pinned && `${pinned.providerID}/${pinned.id}` === key ? " · default for new sessions" : "")))
          b.addEventListener("click", () => {
            this.closePopover()
            const ref = { id: m.id, providerID: m.providerID }
            setDefaultModel(ref)
            s.model = ref
            this.renderHeader()
            void this.transcript.act(() => this.backend.switchModel(id, ref))
          })
          return b
        }),
      )
      if (!hits.length) list.append(h("div", "pop-empty", "No matching models"))
    }
    filter.addEventListener("input", draw)
    filter.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.key === "Escape") this.closePopover()
      if (e.key === "Enter") (list.querySelector(".pop-item") as HTMLButtonElement | null)?.click()
    })
    draw()
    filter.focus()
  }

  private async setAuto(id: string, on: boolean) {
    try {
      await this.store.setSessionAutoApprove(id, on)
      toast(on ? "Auto-approving this session" : "This session will ask for permission again")
      this.renderHeader()
    } catch (e) {
      toast(`Couldn't change permissions: ${(e as Error).message}`)
    }
  }

  private toggleMenu() {
    if (this.popover) return this.closePopover()
    const id = this.id
    const s = id ? this.store.sessions.get(id) : undefined
    if (!id || !s) return
    const copy = (text: string, what: string) => {
      navigator.clipboard.writeText(text).then(
        () => toast(`Copied ${what}`),
        () => toast("Clipboard unavailable"),
      )
    }
    const auto = this.store.sessionAutoApproves(id)
    const items = [
      auto
        ? { label: "Stop auto-approving", sub: "Ask for permission again", run: () => void this.setAuto(id, false) }
        : { label: "Auto-approve this session", sub: "Never stop to ask for permission", run: () => void this.setAuto(id, true) },
      ...(this.tiles
        ? [
            this.tiles.isPinned(id)
              ? { label: "Unpin from Tiles", run: () => this.tiles!.togglePin(id) }
              : { label: "Pin to Tiles", sub: "Keep its chat in the tiled view", run: () => this.tiles!.togglePin(id) },
          ]
        : []),
      { label: "Copy resume command", sub: `hermes chat --resume ${id}`, run: () => copy(`hermes chat --resume ${id}`, "resume command") },
      { label: "Copy session ID", sub: id, run: () => copy(id, "session ID") },
      { label: "Rename", run: () => this.beginRename() },
    ]
    if (s.parentID && this.store.sessions.has(s.parentID))
      items.unshift({ label: "Open parent session", sub: this.store.title(this.store.sessions.get(s.parentID)!), run: () => this.open(s.parentID!) })
    this.showPopover(this.menuBtn, items)
  }

  // ---- composer -----------------------------------------------------------------

  private bindComposer() {
    const input = this.input
    const autosize = () => {
      input.style.height = "auto"
      input.style.height = `${Math.min(220, input.scrollHeight)}px`
    }
    input.addEventListener("input", autosize)
    input.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.isComposing) return
      if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        void this.send(this.store.running.has(this.id ?? "") ? "steer" : undefined)
      } else if (e.key === "Tab" && !e.shiftKey && (input.value.trim() || this.attachments.length)) {
        e.preventDefault()
        void this.send("queue")
      } else if (e.key === "Escape") {
        e.preventDefault()
        if (input.value) input.blur()
        else this.close()
      } else if (e.key === "." && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void this.interrupt()
      }
    })
    input.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"))
      if (!files.length) return
      e.preventDefault()
      for (const f of files) {
        const reader = new FileReader()
        reader.onload = () => {
          this.attachments.push({ uri: String(reader.result), name: f.name || "image.png" })
          this.renderAttachments()
        }
        reader.readAsDataURL(f)
      }
    })
    this.el.addEventListener("dragover", (e) => e.preventDefault())
    this.el.addEventListener("drop", (e) => {
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"))
      if (!files.length) return
      e.preventDefault()
      for (const f of files) {
        const reader = new FileReader()
        reader.onload = () => {
          this.attachments.push({ uri: String(reader.result), name: f.name })
          this.renderAttachments()
        }
        reader.readAsDataURL(f)
      }
    })
  }

  private renderAttachments() {
    this.attachRow.replaceChildren(
      ...this.attachments.map((a, i) => {
        const chip = h("span", "attach-chip")
        const img = h("img") as HTMLImageElement
        img.src = a.uri
        const x = h("button", "x", "×") as HTMLButtonElement
        x.setAttribute("aria-label", `Remove ${a.name}`)
        x.addEventListener("click", () => {
          this.attachments.splice(i, 1)
          this.renderAttachments()
        })
        chip.append(img, h("span", "", basename(a.name)), x)
        return chip
      }),
    )
    this.attachRow.hidden = !this.attachments.length
  }

  private async send(delivery: "steer" | "queue" | undefined) {
    const id = this.id
    const text = this.input.value.trim()
    if (!id || (!text && !this.attachments.length)) return
    const files = this.attachments.length ? [...this.attachments] : undefined
    this.input.value = ""
    this.input.style.height = "auto"
    this.attachments = []
    this.renderAttachments()
    // Optimistic: show it as pending until the server confirms.
    const temp: InboxItem = {
      id: `local_${Date.now()}`,
      sessionID: id,
      type: "user",
      payload: { text },
      delivery: delivery ?? "steer",
    }
    this.transcript.addPending(temp)
    try {
      await this.backend.prompt(id, { text, delivery, files })
      this.transcript.scheduleRefetch(80)
    } catch (e) {
      this.transcript.removePending(temp)
      this.input.value = text
      toast(`Couldn't send: ${(e as Error).message}`)
    }
  }

  focusInput() {
    this.input.focus()
  }
}
