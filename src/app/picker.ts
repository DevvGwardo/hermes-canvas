// "New session" picker: choose one of your projects (or type a folder path,
// with autocomplete) and the model to run it on.

import type { Backend, ModelOption } from "./backend"
import { basename, timeAgo } from "./format"
import { defaultModel, models, serverDefault, setDefaultModel } from "./models"
import type { Store } from "./store"
import type { ModelRef } from "./types"

interface Option {
  kind: "project" | "folder" | "path" | "model" | "server-default"
  label: string
  sub: string
  directory?: string
  model?: ModelRef
  current?: boolean
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const looksLikePath = (q: string) => /^(~|\/|\.\.?\/)/.test(q)
const keyOf = (m?: ModelRef) => (m ? `${m.providerID}/${m.id}` : "")

const ICON: Record<Option["kind"], string> = {
  project: "◆",
  folder: "▸",
  path: "+",
  model: "◇",
  "server-default": "◇",
}

export class NewSessionPicker {
  private el?: HTMLElement
  private input!: HTMLInputElement
  private list!: HTMLElement
  private foot!: HTMLElement
  private modelBtn!: HTMLButtonElement
  private autoBox!: HTMLInputElement
  private options: Option[] = []
  private active = 0
  private seq = 0
  private folderCache = new Map<string, Promise<string[]>>()
  private mode: "where" | "model" = "where"
  private whereQuery = ""
  private preferred?: string
  /** undefined = OpenCode's configured default. */
  private model?: ModelRef

  constructor(
    private host: HTMLElement,
    private store: Store,
    private backend: Backend,
    private home: string | undefined,
    private onPick: (directory: string, model: ModelRef | undefined, autoApprove: boolean) => Promise<void>,
  ) {}

  get isOpen() {
    return !!this.el
  }

  open(preferDirectory?: string) {
    if (this.el) return this.input.focus()
    this.preferred = preferDirectory
    this.model = defaultModel()
    this.mode = "where"
    this.whereQuery = ""

    const scrim = h("div", "picker-scrim")
    scrim.addEventListener("pointerdown", () => this.close())
    const box = h("div", "picker")
    box.setAttribute("role", "dialog")
    box.setAttribute("aria-label", "New session")
    box.addEventListener("pointerdown", (e) => e.stopPropagation())

    const head = h("div", "picker-head")
    this.modelBtn = h("button", "picker-model-btn") as HTMLButtonElement
    this.modelBtn.title = "Choose the model (Shift+Tab)"
    this.modelBtn.addEventListener("click", () => this.setMode(this.mode === "model" ? "where" : "model"))
    const auto = h("label", "picker-auto")
    this.autoBox = h("input") as HTMLInputElement
    this.autoBox.type = "checkbox"
    this.autoBox.checked = this.store.autoApproveAll
    auto.title = "Start the session with an allow-everything rule: it never stops to ask for permission"
    auto.append(this.autoBox, document.createTextNode(" Auto-approve"))
    const headRight = h("div", "picker-head-right")
    headRight.append(auto, this.modelBtn)
    head.append(h("span", "picker-title", "New session"), headRight)

    this.input = h("input", "picker-input") as HTMLInputElement
    this.input.spellcheck = false
    this.input.autocomplete = "off"
    this.list = h("div", "picker-list")
    this.list.setAttribute("role", "listbox")
    this.foot = h("div", "picker-foot")
    box.append(head, this.input, this.list, this.foot)
    scrim.append(box)
    this.host.append(scrim)
    this.el = scrim

    this.input.addEventListener("input", () => void this.refresh())
    this.input.addEventListener("keydown", (e) => this.onKey(e))
    this.setMode("where")
    void this.renderModelButton()
    requestAnimationFrame(() => this.input.focus())
  }

  close() {
    this.el?.remove()
    this.el = undefined
  }

  private setMode(mode: "where" | "model") {
    if (mode === "model" && this.mode === "where") this.whereQuery = this.input.value
    this.mode = mode
    this.modelBtn.classList.toggle("on", mode === "model")
    this.input.value = mode === "where" ? this.whereQuery : ""
    this.input.placeholder =
      mode === "where" ? "Search projects, or type a folder path (~/code/app)" : "Search models (e.g. anthropic sonnet)"
    this.input.setAttribute("aria-label", mode === "where" ? "Project or folder" : "Model")
    this.foot.innerHTML =
      mode === "where"
        ? `<span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Tab</kbd> into folder</span><span><kbd>⇧</kbd><kbd>Tab</kbd> model</span><span><kbd>Enter</kbd> start</span><span><kbd>Esc</kbd> cancel</span>`
        : `<span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> use model</span><span><kbd>Esc</kbd> back</span>`
    void this.refresh()
    this.input.focus()
  }

  private async renderModelButton() {
    const btn = this.modelBtn
    btn.replaceChildren(h("span", "pm-k", "Model"))
    let name: string
    let sub: string
    if (this.model) {
      const all = await models(this.backend).catch(() => [] as ModelOption[])
      const m = all.find((x) => keyOf(x) === keyOf(this.model))
      name = m?.name ?? this.model.id
      sub = this.model.providerID
    } else {
      const d = await serverDefault(this.backend)
      name = d ? d.name : "Hermes default"
      sub = d ? "Hermes default" : ""
    }
    if (btn !== this.modelBtn) return
    btn.append(h("span", "pm-v", name))
    if (sub) btn.append(h("span", "pm-s", sub))
    btn.append(h("span", "pm-caret", "▾"))
  }

  // ---- where -------------------------------------------------------------------

  private expand(q: string) {
    if (q === "~" || q.startsWith("~/")) return (this.home ?? "") + q.slice(1)
    return q
  }

  private show(p: string) {
    return this.home && p.startsWith(this.home) ? "~" + p.slice(this.home.length) : p
  }

  private folders(dir: string) {
    let p = this.folderCache.get(dir)
    if (!p) {
      p = this.backend.listFolders(dir).catch(() => [])
      this.folderCache.set(dir, p)
    }
    return p
  }

  private projectOptions(q: string): Option[] {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    const seen = new Set<string>()
    const out: Option[] = []
    for (const g of this.store.groups()) {
      if (seen.has(g.directory)) continue
      seen.add(g.directory)
      const hay = `${g.label} ${g.directory}`.toLowerCase()
      if (!terms.every((t) => hay.includes(t))) continue
      const n = g.sessions.length
      out.push({
        kind: "project",
        label: g.label,
        sub: `${this.show(g.directory)} · ${n} session${n === 1 ? "" : "s"} · ${timeAgo(g.updated)}`,
        directory: g.directory,
      })
    }
    if (this.preferred && !q) {
      const i = out.findIndex((o) => o.directory === this.preferred)
      if (i > 0) out.unshift(...out.splice(i, 1))
    }
    return out.slice(0, 60)
  }

  private async folderOptions(raw: string, seq: number): Promise<Option[] | undefined> {
    const path = this.expand(raw)
    // List the parent, filter by the last segment.
    const slash = path.lastIndexOf("/")
    const parent = slash <= 0 ? "/" : path.slice(0, slash)
    const leaf = path.slice(slash + 1).toLowerCase()
    const exact = path.endsWith("/") ? path.replace(/\/+$/, "") || "/" : path
    const [kids, exactKids] = await Promise.all([
      this.folders(parent),
      path.endsWith("/") ? this.folders(exact) : Promise.resolve(null),
    ])
    if (seq !== this.seq) return undefined
    const exists = path.endsWith("/") ? (exactKids?.length ?? 0) > 0 || exact === "/" : kids.includes(path.slice(slash + 1))
    const start: Option = {
      kind: "path",
      label: `Start in ${this.show(exact)}`,
      sub: exists ? "New session in this folder" : "No folder here yet. Pick one below or keep typing",
      directory: exact,
    }
    const opts: Option[] = exists ? [start] : []
    const base = path.endsWith("/") ? exact : parent
    const names = (path.endsWith("/") ? (exactKids ?? []) : kids.filter((k) => k.toLowerCase().startsWith(leaf) && k.toLowerCase() !== leaf))
      .filter((k) => !k.startsWith(".") || leaf.startsWith("."))
      .slice(0, 40)
    for (const k of names) {
      const dir = (base === "/" ? "" : base) + "/" + k
      opts.push({ kind: "folder", label: k, sub: this.show(dir), directory: dir })
    }
    if (!exists) opts.push(start)
    return opts
  }

  // ---- model -------------------------------------------------------------------

  private async modelOptions(q: string, seq: number): Promise<Option[] | undefined> {
    const [all, def] = await Promise.all([models(this.backend).catch(() => [] as ModelOption[]), serverDefault(this.backend)])
    if (seq !== this.seq) return undefined
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    const match = (s: string) => terms.every((t) => s.toLowerCase().includes(t))
    const current = keyOf(this.model)
    const out: Option[] = []
    if (match(`default hermes ${def?.name ?? ""} ${keyOf(def)}`))
      out.push({
        kind: "server-default",
        label: "Hermes default",
        sub: def ? `${def.name} · ${keyOf(def)} (from your Hermes config)` : "Whatever your Hermes config picks",
        current: !this.model,
      })
    const hits = all.filter((m) => match(`${keyOf(m)} ${m.name}`))
    // Current choice first, then the server's order.
    hits.sort((a, b) => Number(keyOf(b) === current) - Number(keyOf(a) === current))
    for (const m of hits.slice(0, 80))
      out.push({
        kind: "model",
        label: m.name,
        sub: keyOf(m),
        model: { id: m.id, providerID: m.providerID },
        current: keyOf(m) === current,
      })
    return out
  }

  // ---- list ----------------------------------------------------------------------

  private async refresh() {
    const seq = ++this.seq
    const raw = this.input.value.trim()
    let opts: Option[] | undefined
    let empty = ""
    if (this.mode === "model") {
      opts = await this.modelOptions(raw, seq)
      empty = "No matching models"
    } else if (looksLikePath(raw)) {
      opts = await this.folderOptions(raw, seq)
    } else {
      opts = this.projectOptions(raw)
      empty = raw ? "No matching projects. Type a path like ~/code/app to start somewhere new." : "No projects yet. Type a folder path."
    }
    if (!opts || seq !== this.seq) return
    this.options = opts
    this.active = Math.max(0, this.mode === "model" && !raw ? opts.findIndex((o) => o.current) : 0)
    this.render(empty)
  }

  private render(empty: string) {
    this.list.replaceChildren()
    if (!this.options.length) {
      this.list.append(h("div", "picker-empty", empty))
      return
    }
    this.options.forEach((o, i) => {
      const b = h("button", `picker-item ${o.kind}${i === this.active ? " active" : ""}${o.current ? " current" : ""}`) as HTMLButtonElement
      b.setAttribute("role", "option")
      b.setAttribute("aria-selected", String(i === this.active))
      b.append(h("span", "picker-icon", ICON[o.kind]), h("span", "picker-label", o.label), h("span", "picker-sub", o.sub))
      b.addEventListener("click", () => {
        this.active = i
        if (o.kind === "folder") this.complete()
        else void this.choose()
      })
      b.addEventListener("dblclick", () => {
        this.active = i
        void this.choose()
      })
      this.list.append(b)
    })
    this.list.children[this.active]?.scrollIntoView({ block: "nearest" })
  }

  private complete() {
    const o = this.options[this.active]
    if (!o?.directory) return
    this.input.value = this.show(o.directory) + "/"
    void this.refresh()
    this.input.focus()
  }

  private async choose() {
    const o = this.options[this.active]
    if (!o) return
    if (this.mode === "model") {
      this.model = o.kind === "server-default" ? undefined : o.model
      setDefaultModel(this.model) // remembered for the next new session
      await this.renderModelButton()
      return this.setMode("where")
    }
    if (!o.directory) return
    // Make sure a typed folder exists before creating a session there.
    if (o.kind !== "project" && o.directory !== "/") {
      const parent = o.directory.slice(0, o.directory.lastIndexOf("/")) || "/"
      const siblings = await this.folders(parent)
      if (!siblings.includes(basename(o.directory))) {
        this.list.replaceChildren(h("div", "picker-empty error", `${o.directory} doesn't exist (or isn't a folder).`))
        return
      }
    }
    this.close()
    await this.onPick(o.directory, this.model, this.autoBox.checked)
  }

  private onKey(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === "Escape") {
      e.preventDefault()
      if (this.mode === "model") this.setMode("where")
      else this.close()
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!this.options.length) return
      this.active = (this.active + (e.key === "ArrowDown" ? 1 : -1) + this.options.length) % this.options.length
      this.render("")
    } else if (e.key === "Tab") {
      e.preventDefault()
      if (e.shiftKey) return this.setMode(this.mode === "model" ? "where" : "model")
      if (this.mode === "model") return
      const o = this.options[this.active]
      // Tab goes into the highlighted folder or project to browse inside it.
      if (o?.directory) this.complete()
    } else if (e.key === "Enter") {
      e.preventDefault()
      void this.choose()
    }
  }
}
