// The launchpad: one chat box on the canvas for starting sessions without
// opening the New session picker. Team mode (the default) creates a lead
// session and lets Hermes' own delegate_task tool fan the work out to
// subagents, which the canvas already renders as nested child cards.
//
// Each launch is a fresh root session, so a second task never touches the
// first team. The strip above the box tracks recent launches and doubles as a
// shortcut to their cards.

import type { Backend } from "./backend"
import { basename } from "./format"
import { launchPrompt, missionLabel, parseMention } from "./launch"
import { defaultModel, modelLabel } from "./models"
import { ALLOW_ALL, STATUS_LABEL, type Store } from "./store"
import { toast } from "./toast"

const MISSIONS_KEY = "hermes-canvas.missions"
const TEAM_KEY = "hermes-canvas.launch.team"
const DIR_KEY = "hermes-canvas.launch.dir"
const MAX_MISSIONS = 8

interface Mission {
  id: string
  prompt: string
  directory: string
  at: number
  /** The row was created but the first prompt never started. */
  failed?: boolean
}

export interface LaunchpadOptions {
  /** Fallback directory when there is no selected card and no projects yet. */
  home?: string
  /** The project of the currently selected canvas card, if any. */
  selectedDirectory(): string | undefined
  openSession(id: string): void
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
const sameDir = (a?: string, b?: string) => !!a && !!b && norm(a) === norm(b)

const readJSON = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T
  } catch {
    return fallback
  }
}

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode */
  }
}

function readMissions(): Mission[] {
  const raw = readJSON<unknown>(MISSIONS_KEY, [])
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (m): m is Mission =>
        !!m &&
        typeof m === "object" &&
        typeof (m as Mission).id === "string" &&
        typeof (m as Mission).prompt === "string" &&
        typeof (m as Mission).directory === "string",
    )
    .slice(0, MAX_MISSIONS)
}

function readTeam(): boolean {
  try {
    const v = localStorage.getItem(TEAM_KEY)
    return v === null ? true : v === "1"
  } catch {
    return true
  }
}

function readDir(): string | undefined {
  try {
    return localStorage.getItem(DIR_KEY) || undefined
  } catch {
    return undefined
  }
}

const looksLikePath = (q: string) => /^(~|[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])/.test(q)

interface DestOption {
  label: string
  sub: string
  directory: string
  custom?: boolean
  /** Return to following the canvas selection instead of a pinned project. */
  follow?: boolean
}

export class Launchpad {
  private el: HTMLElement
  private feed: HTMLElement
  private input: HTMLTextAreaElement
  private sendBtn: HTMLButtonElement
  private destBtn: HTMLButtonElement
  private destLabel: HTMLElement
  private modeBtn: HTMLButtonElement
  private note: HTMLElement
  private menu?: HTMLElement
  private menuOutside?: (e: PointerEvent) => void
  private missions = readMissions()
  private team = readTeam()
  private directory = readDir()
  private pinned = this.directory !== undefined
  private busy = false

  constructor(
    host: HTMLElement,
    private store: Store,
    private backend: Backend,
    private opts: LaunchpadOptions,
  ) {
    this.el = h("section", "launchpad")
    this.el.setAttribute("aria-label", "Launch a task")

    this.feed = h("div", "launch-feed")
    this.feed.setAttribute("role", "group")
    this.feed.setAttribute("aria-label", "Recent launches")
    this.feed.hidden = true

    const box = h("div", "launch-box")

    const controls = h("div", "launch-controls")
    this.destBtn = h("button", "launch-dest") as HTMLButtonElement
    this.destBtn.type = "button"
    this.destBtn.title = "Where the new session runs. Click to change, or type @project in the task."
    this.destBtn.setAttribute("aria-haspopup", "dialog")
    this.destBtn.setAttribute("aria-expanded", "false")
    const mark = h("span", "ld-mark", "◆")
    mark.setAttribute("aria-hidden", "true")
    const caret = h("span", "ld-caret", "▾")
    caret.setAttribute("aria-hidden", "true")
    this.destBtn.append(mark)
    this.destLabel = h("span", "ld-label")
    this.destBtn.append(this.destLabel, caret)
    this.destBtn.addEventListener("pointerdown", (e) => e.stopPropagation())
    this.destBtn.addEventListener("click", () => (this.menu ? this.closeMenu() : this.openDest()))

    this.modeBtn = h("button", "launch-mode") as HTMLButtonElement
    this.modeBtn.type = "button"
    this.modeBtn.addEventListener("click", () => this.setTeam(!this.team))

    controls.append(this.destBtn, h("span", "launch-spacer"), this.modeBtn)

    const row = h("div", "launch-row")
    this.input = h("textarea", "launch-input") as HTMLTextAreaElement
    this.input.rows = 1
    this.input.spellcheck = true
    this.input.autocomplete = "off"
    this.input.setAttribute("aria-label", "Task to launch")
    this.input.addEventListener("input", () => {
      this.autosize()
    })
    this.input.addEventListener("keydown", (e) => this.onKey(e))
    this.input.addEventListener("focus", () => {
      this.refresh()
      this.autosize()
    })

    this.sendBtn = h("button", "launch-send", "↑") as HTMLButtonElement
    this.sendBtn.type = "button"
    this.sendBtn.title = "Launch (Enter)"
    this.sendBtn.setAttribute("aria-label", "Launch task")
    this.sendBtn.addEventListener("click", () => void this.launch())

    row.append(this.input, this.sendBtn)
    box.append(controls, row)

    this.note = h("div", "launch-note")
    this.el.append(this.feed, box, this.note)
    host.append(this.el)

    this.refresh()
    this.store.on({ structure: () => this.refresh() })
    setInterval(() => this.renderFeed(), 1000)
  }

  /** Focus the task box (the `L` shortcut). */
  focus() {
    this.input.focus()
  }

  /** Repaint the destination chip after the canvas selection changes. */
  refreshDestination() {
    this.refresh()
  }

  private autosize() {
    this.input.style.height = "auto"
    this.input.style.height = `${Math.min(160, this.input.scrollHeight)}px`
  }

  private onKey(e: KeyboardEvent) {
    e.stopPropagation()
    // Don't launch while an IME is still composing (Enter confirms the candidate).
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      void this.launch()
    } else if (e.key === "Escape") {
      e.preventDefault()
      this.closeMenu()
      if (this.input.value) {
        this.input.value = ""
        this.autosize()
      } else this.input.blur()
    }
  }

  private refresh() {
    const dir = this.currentDir()
    const label = this.destLabelFor(dir)
    this.destLabel.textContent = label
    this.destBtn.title = `${dir || "Choose a project"} · click to change`
    this.modeBtn.classList.toggle("on", this.team)
    this.modeBtn.textContent = this.team ? "Team" : "Solo"
    this.modeBtn.setAttribute("aria-pressed", String(this.team))
    this.modeBtn.title = this.team
      ? "Team: the lead session splits the task into subagents with delegate_task (parallel, more tokens)"
      : "Solo: one session with no subagents"
    this.input.placeholder = this.team
      ? "Describe a task. Enter launches a team of Hermes subagents."
      : "Describe a task. Enter launches one Hermes session."
    this.note.textContent = this.team
      ? `Enter launches a team · ${modelLabel(defaultModel())} · Shift+Enter for a new line`
      : `Enter launches one session · ${modelLabel(defaultModel())} · Shift+Enter for a new line`
    this.renderFeed()
  }

  private currentDir(): string {
    if (this.pinned && this.directory) return this.directory
    return (
      this.opts.selectedDirectory() ||
      this.store.groups()[0]?.directory ||
      this.directory ||
      this.opts.home ||
      ""
    )
  }

  private destLabelFor(dir: string) {
    const group = this.store.groups().find((g) => sameDir(g.directory, dir))
    if (group) return group.label
    if (sameDir(dir, this.opts.home)) return "Home"
    return basename(dir) || "Choose project"
  }

  private setDirectory(dir: string, pinned: boolean) {
    this.directory = dir
    this.pinned = pinned
    if (pinned) write(DIR_KEY, dir)
    this.refresh()
  }

  private setTeam(team: boolean) {
    this.team = team
    write(TEAM_KEY, team ? "1" : "0")
    this.refresh()
    this.input.focus()
  }

  private async launch() {
    if (this.busy) return
    const original = this.input.value.trim()
    if (!original) return

    const mention = parseMention(original, this.store.groups())
    if (mention.directory) this.setDirectory(mention.directory, true)
    const task = mention.text
    if (!task) return

    const dir = this.currentDir()
    if (!dir) {
      this.openDest()
      toast("Choose where the task should run")
      return
    }

    const team = this.team
    const model = defaultModel()
    const autoApprove = this.store.autoApproveAll
    this.busy = true
    this.el.setAttribute("aria-busy", "true")
    this.sendBtn.disabled = true
    this.sendBtn.textContent = "…"
    let createdID: string | undefined
    try {
      const session = await this.backend.createSession(
        dir,
        model,
        autoApprove ? [ALLOW_ALL] : undefined,
      )
      createdID = session.id
      this.store.sessions.set(session.id, session)
      // Show the card as working immediately; the server's started event
      // confirms it a moment later.
      this.store.running.add(session.id)
      this.store.touchCard(session.id)
      this.store.markStructure()
      await this.backend.prompt(session.id, { text: launchPrompt(task, team) })
      this.record(session.id, task, dir)
      // Don't wipe a next task typed while the launcher was starting.
      if (this.input.value.trim() === original) {
        this.input.value = ""
        this.autosize()
      }
      this.refresh()
    } catch (e) {
      if (createdID) {
        this.store.running.delete(createdID)
        this.store.touchCard(createdID)
        // The row exists even though prompting failed; keep it reachable
        // from the launch strip so it isn't an invisible orphan.
        this.record(createdID, task, dir, true)
      }
      // Leave a next task the user already typed alone.
      if (!this.input.value.trim()) {
        this.input.value = original
        this.autosize()
      }
      toast(
        createdID
          ? `Session created, but the prompt failed: ${(e as Error).message}`
          : `Couldn't launch: ${(e as Error).message}`,
      )
    } finally {
      this.busy = false
      this.el.setAttribute("aria-busy", "false")
      this.sendBtn.disabled = false
      this.sendBtn.textContent = "↑"
      // Keep the next task ready, but don't steal focus from a panel or menu
      // the user opened while the launcher was starting.
      const active = document.activeElement
      if (active === this.input || active === this.sendBtn) this.input.focus()
    }
  }

  private record(id: string, prompt: string, directory: string, failed = false) {
    this.missions = [
      { id, prompt: prompt.slice(0, 4000), directory, at: Date.now(), failed },
      ...this.missions.filter((m) => m.id !== id),
    ].slice(0, MAX_MISSIONS)
    write(MISSIONS_KEY, JSON.stringify(this.missions))
    this.renderFeed()
  }

  private feedKey = ""

  private renderFeed() {
    const live = this.missions.filter((m) => this.store.sessions.has(m.id))
    const statusOf = (m: Mission) => {
      const s = this.store.sessions.get(m.id)
      const ran = !!s && (this.store.isWorking(m.id) || !!s.outcome || !!s.time.idle)
      return m.failed && !ran ? "failed" : this.store.status(m.id)
    }
    const key = live
      .map((m) => `${m.id}:${statusOf(m)}:${this.store.subagentCount(m.id)}`)
      .join("|")
    if (key === this.feedKey) return
    this.feedKey = key
    this.feed.hidden = live.length === 0
    this.feed.replaceChildren()
    for (const m of live) {
      const status = statusOf(m)
      const n = this.store.subagentCount(m.id)
      const chip = h("button", "launch-mission") as HTMLButtonElement
      chip.type = "button"
      chip.dataset.status = status
      chip.title = `${m.prompt}\n\n${m.directory}\nClick to open its card; reply there to continue this task.`
      const dot = h("span", "lm-dot")
      dot.setAttribute("aria-hidden", "true")
      chip.append(dot)
      chip.append(h("span", "lm-text", missionLabel(m.prompt)))
      chip.append(
        h("span", "lm-meta", n ? `${n} agent${n === 1 ? "" : "s"}` : STATUS_LABEL[status].toLowerCase()),
      )
      chip.addEventListener("click", () => this.opts.openSession(m.id))
      this.feed.append(chip)
    }
  }

  // ---- destination menu -----------------------------------------------------

  private openDest() {
    if (this.menu) return this.closeMenu()

    const menu = h("div", "launch-menu")
    menu.setAttribute("role", "dialog")
    menu.setAttribute("aria-label", "Choose where to launch")
    const input = h("input", "launch-menu-input") as HTMLInputElement
    input.placeholder = "Filter projects or type a folder path"
    input.setAttribute("aria-label", "Project or folder")
    input.autocomplete = "off"
    input.spellcheck = false
    const list = h("div", "launch-menu-list")
    list.setAttribute("role", "listbox")
    list.setAttribute("aria-label", "Projects and folders")
    menu.append(input, list)
    this.el.append(menu)
    this.menu = menu
    this.destBtn.setAttribute("aria-expanded", "true")

    let options: DestOption[] = []
    let active = 0

    const paint = () => {
      list.replaceChildren()
      if (!options.length) {
        list.append(h("div", "launch-menu-empty", "No matching projects. Type a folder path."))
        return
      }
      active = Math.min(active, options.length - 1)
      options.forEach((o, i) => {
        const b = h("button", `launch-menu-item${i === active ? " active" : ""}${o.custom ? " custom" : ""}`) as HTMLButtonElement
        b.type = "button"
        b.tabIndex = -1
        b.setAttribute("role", "option")
        b.setAttribute("aria-selected", String(i === active))
        const mark = h("span", "lmi-mark", o.custom ? "+" : o.follow ? "◎" : "◆")
        mark.setAttribute("aria-hidden", "true")
        b.append(mark)
        b.append(h("span", "lmi-label", o.label), h("span", "lmi-sub", o.sub))
        b.addEventListener("pointerenter", () => {
          active = i
          for (const [j, el] of [...list.children].entries()) {
            el.classList.toggle("active", j === i)
            el.setAttribute("aria-selected", String(j === i))
          }
        })
        b.addEventListener("click", () => void choose(o))
        list.append(b)
      })
      list.children[active]?.scrollIntoView({ block: "nearest" })
    }

    const collect = (q: string) => {
      const raw = q.trim()
      const terms = raw.toLowerCase().split(/\s+/).filter(Boolean)
      options = []
      if (raw && looksLikePath(raw)) {
        options.push({
          label: `Use ${raw}`,
          sub: "Launch in this folder",
          directory: this.expand(raw),
          custom: true,
        })
      }
      const selected = this.opts.selectedDirectory()
      if (!raw && selected) {
        options.push({
          label: "Follow selection",
          sub: `${selected} · use the card you select on the canvas`,
          directory: selected,
          follow: true,
        })
      }
      const seen = new Set<string>()
      for (const g of this.store.groups()) {
        if (options.length >= 60) break
        if (seen.has(norm(g.directory))) continue
        seen.add(norm(g.directory))
        if (!terms.every((t) => `${g.label} ${g.directory}`.toLowerCase().includes(t))) continue
        options.push({ label: g.label, sub: g.directory, directory: g.directory })
      }
      if (raw) {
        active = Math.min(active, Math.max(0, options.length - 1))
      } else {
        const current = this.currentDir()
        const i = options.findIndex((o) => sameDir(o.directory, current))
        active = i >= 0 ? i : 0
      }
      paint()
    }

    const choose = async (o: DestOption) => {
      if (o.custom) {
        try {
          await this.backend.listFolders(o.directory)
        } catch {
          if (this.menu !== menu) return
          input.classList.add("bad")
          input.placeholder = "That folder isn't readable. Pick another."
          input.focus()
          return
        }
        // The menu may have been dismissed while the folder was validating.
        if (this.menu !== menu) return
      }
      if (o.follow) {
        this.pinned = false
        this.directory = this.opts.selectedDirectory()
        write(DIR_KEY, "")
        this.refresh()
      } else {
        this.setDirectory(o.directory, true)
      }
      this.closeMenu()
      this.input.focus()
    }

    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === "Escape") {
        e.preventDefault()
        this.closeMenu()
        this.input.focus()
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        if (!options.length) return
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
        paint()
      } else if (e.key === "Enter") {
        e.preventDefault()
        const o = options[active]
        if (o) void choose(o)
      }
    }

    const outside = (e: PointerEvent) => {
      if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu()
    }

    input.addEventListener("input", () => {
      input.classList.remove("bad")
      input.placeholder = "Filter projects or type a folder path"
      collect(input.value)
    })
    input.addEventListener("keydown", onKey)
    collect("")
    input.focus()
    this.menuOutside = outside
    setTimeout(() => {
      if (this.menu === menu) document.addEventListener("pointerdown", outside)
    }, 0)
    menu.addEventListener("pointerdown", (e) => e.stopPropagation())
  }

  private closeMenu() {
    const menu = this.menu
    if (!menu) return
    if (this.menuOutside) document.removeEventListener("pointerdown", this.menuOutside)
    this.menuOutside = undefined
    menu.remove()
    this.menu = undefined
    this.destBtn.setAttribute("aria-expanded", "false")
  }

  private expand(q: string) {
    if (!this.opts.home) return q
    if (q === "~") return this.opts.home
    if (q.startsWith("~/") || q.startsWith("~\\")) return this.opts.home + q.slice(1)
    return q
  }
}
