import type { ModelRef } from "./types"
import { type Backend, type ConnectionState } from "./backend"
import { HermesBackend } from "./hermes-backend"
import { CanvasView } from "./canvas"
import { DemoBackend } from "./demo"
import { LAYOUTS, type LayoutName } from "./layouts"
import { defaultModel } from "./models"
import { SessionPanel } from "./panel"
import { NewSessionPicker } from "./picker"
import { TilesView } from "./tiles"
import { autoApproveToggle, autoApprovedNotices } from "./approve"
import { SPINNERS, setSpinnerStyle, spinner, type SpinnerStyle } from "./spinners"
import { ALLOW_ALL, STATUS_LABEL, Store, type Status } from "./store"
import { toast } from "./toast"

interface CanvasConfig {
  mode: "live" | "demo"
  connected: boolean
  version?: string
  upstream?: string
  home?: string
  error?: string
}

const pref = {
  get<T extends string>(k: string, fallback: T, allowed: readonly T[]): T {
    try {
      const v = localStorage.getItem(`hermes-canvas.${k}`) as T | null
      return v && allowed.includes(v) ? v : fallback
    } catch {
      return fallback
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(`hermes-canvas.${k}`, v)
    } catch {
      /* private mode */
    }
  },
}

const LAYOUT_LABEL: Record<LayoutName, string> = { satellites: "Satellites", fold: "Fold", tabs: "Tabs", tree: "Tree" }
const SPINNER_LABEL: Record<SpinnerStyle, string> = { wave: "Wave", matrix: "Matrix", braid: "Braid", mist: "Mist", comet: "Comet" }

async function getConfig(): Promise<CanvasConfig> {
  try {
    const r = await fetch("/canvas/config")
    if (r.ok) return await r.json()
    return { mode: "live", connected: false, error: `Canvas server responded ${r.status}` }
  } catch (e) {
    return { mode: "live", connected: false, error: (e as Error).message }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function segmented<T extends string>(items: readonly T[], labels: Record<T, string>, current: T, onPick: (v: T) => void, name: string) {
  const group = el("div", "seg")
  group.setAttribute("role", "radiogroup")
  group.setAttribute("aria-label", name)
  const buttons = new Map<T, HTMLButtonElement>()
  for (const it of items) {
    const b = el("button", "seg-btn", labels[it]) as HTMLButtonElement
    b.setAttribute("role", "radio")
    b.addEventListener("click", () => {
      set(it)
      onPick(it)
    })
    buttons.set(it, b)
    group.append(b)
  }
  const set = (v: T) => {
    for (const [k, b] of buttons) {
      b.classList.toggle("on", k === v)
      b.setAttribute("aria-checked", String(k === v))
    }
  }
  set(current)
  return { group, set }
}

function showUnavailable(root: HTMLElement, cfg: CanvasConfig) {
  root.replaceChildren()
  const box = el("div", "empty-state")
  box.append(
    el("div", "empty-mark", "◐"),
    el("h1", "", "Can't reach Hermes"),
    el(
      "p",
      "",
      cfg.error ??
        "The Hermes session store didn't answer. Check that your Hermes home (state.db) exists and is readable.",
    ),
  )
  const actions = el("div", "empty-actions")
  const retry = el("button", "btn primary", "Try again") as HTMLButtonElement
  retry.addEventListener("click", () => location.reload())
  const demo = el("button", "btn", "Explore simulated sessions") as HTMLButtonElement
  demo.addEventListener("click", () => {
    const u = new URL(location.href)
    u.searchParams.set("demo", "1")
    location.href = u.toString()
  })
  actions.append(retry, demo)
  box.append(actions)
  root.append(box)
}

async function boot() {
  const root = document.getElementById("app")!
  const params = new URLSearchParams(location.search)
  const cfg = await getConfig()
  const demo = params.has("demo") || cfg.mode === "demo"
  if (!demo && !cfg.connected) return showUnavailable(root, cfg)

  const backend: Backend = demo ? new DemoBackend() : new HermesBackend()
  const store = new Store(backend)

  root.replaceChildren()
  root.classList.add("ready")

  let layoutName = pref.get<LayoutName>("layout", "tree", LAYOUTS)
  let spinnerStyle = pref.get<SpinnerStyle>("spinner", "comet", SPINNERS)
  setSpinnerStyle(spinnerStyle)
  root.dataset.layout = layoutName

  let panel: SessionPanel
  const canvas = new CanvasView(root, store, {
    open: (id) => openSession(id),
    newSession: (group) => void newSession(group),
  })
  canvas.setLayout(layoutName)
  root.dataset.layout = layoutName
  // Handy from the devtools console.
  ;(window as any).hermesCanvas = { canvas, store }

  panel = new SessionPanel(root, store, backend, canvas, () => {
    root.classList.remove("panel-open")
    if (location.hash) history.replaceState(null, "", location.pathname + location.search)
  })

  function openSession(id: string) {
    const from = canvas.cardRect(id)
    canvas.select(id, false)
    canvas.centerOn(id, Math.max(0.9, Math.min(1, canvas.camera.z)))
    root.classList.add("panel-open")
    panel.open(id, from)
    history.replaceState(null, "", `#${id}`)
  }

  async function newSession(groupKey: string) {
    const g = store.groups().find((x) => x.key === groupKey)
    if (g) await createIn(g.directory)
  }

  async function createIn(directory: string, model: ModelRef | undefined = defaultModel(), autoApprove = store.autoApproveAll) {
    try {
      const s = await backend.createSession(directory, model, autoApprove ? [ALLOW_ALL] : undefined)
      store.sessions.set(s.id, s)
      store.markStructure()
      // Wait a frame for the card to exist, then open it.
      requestAnimationFrame(() => requestAnimationFrame(() => openSession(s.id)))
    } catch (e) {
      toast(`Couldn't create a session: ${(e as Error).message}`)
    }
  }

  const tiles = new TilesView(root, store, backend, {
    openOnCanvas: (id) => requestAnimationFrame(() => openSession(id)),
    newSession: () => openPicker(),
    closed: () => {
      updateStats()
      if (location.hash === "#tiles") history.replaceState(null, "", location.pathname + location.search)
    },
  })
  panel.tiles = tiles
  function openTiles() {
    if (panel.isOpen) panel.close()
    tiles.open()
    history.replaceState(null, "", "#tiles")
    updateStats()
  }

  const picker = new NewSessionPicker(root, store, backend, demo ? "/Users/you" : cfg.home, createIn)
  const openPicker = () => {
    const sel = canvas.selected ? store.sessions.get(canvas.selected) : undefined
    picker.open(sel?.location.directory)
  }

  // ---- chrome ----

  const top = el("div", "topbar")
  const brand = el("div", "brand")
  const dot = el("span", "conn-dot")
  const stats = el("span", "stats")
  brand.append(dot, el("span", "brand-name", "hermes"))

  // Status counts double as filters: click one to see just those sessions.
  const chips = el("div", "chips")
  chips.setAttribute("role", "group")
  chips.setAttribute("aria-label", "Filter by status")
  const CHIP_ORDER: Status[] = ["needs-you", "working", "review"]
  const chipEls = new Map<Status, HTMLButtonElement>()
  for (const st of CHIP_ORDER) {
    const b = el("button", `chip ${st}`) as HTMLButtonElement
    b.innerHTML = `<span class="chip-dot"></span><span class="chip-n">0</span><span class="chip-label">${STATUS_LABEL[st].toLowerCase()}</span>`
    b.addEventListener("click", () => setFilter(canvas.filter === st ? undefined : st))
    chipEls.set(st, b)
    chips.append(b)
  }
  // One click approves every waiting permission request, everywhere.
  const allowAll = el("button", "chip-action allow", "Allow all") as HTMLButtonElement
  allowAll.hidden = true
  allowAll.title = "Approve every waiting permission request once"
  allowAll.addEventListener("click", async () => {
    const n = await store.approveAllPending()
    toast(n ? `Approved ${n} request${n === 1 ? "" : "s"}` : "Nothing waiting")
  })
  chipEls.get("needs-you")!.after(allowAll)
  const markAll = el("button", "chip-action", "Mark all reviewed") as HTMLButtonElement
  markAll.hidden = true
  markAll.addEventListener("click", () => {
    const t = Date.now()
    let n = 0
    for (const s of store.roots())
      if (store.inFilter(s.id, "review", t)) {
        store.markViewed(s.id)
        n++
      }
    toast(n ? `Marked ${n} session${n === 1 ? "" : "s"} as reviewed` : "Nothing to review")
  })
  chips.append(markAll, stats)
  brand.append(chips)

  function setFilter(st: Status | undefined) {
    canvas.setStatusFilter(st)
    for (const [k, b] of chipEls) {
      b.classList.toggle("on", k === st)
      b.setAttribute("aria-pressed", String(k === st))
    }
    markAll.hidden = st !== "review"
    root.classList.toggle("filtering", !!st)
  }

  const search = el("label", "search")
  search.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.4 10.4 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
  const searchInput = el("input") as HTMLInputElement
  searchInput.type = "search"
  searchInput.placeholder = "Search"
  searchInput.setAttribute("aria-label", "Search sessions")
  searchInput.autocomplete = "off"
  searchInput.spellcheck = false
  search.append(searchInput)

  const right = el("div", "top-right")
  if (demo) right.append(el("span", "badge", "Simulated"))
  const tilesBtn = el("button", "tiles-open-btn") as HTMLButtonElement
  tilesBtn.innerHTML = `<span class="tiles-icon" aria-hidden="true"></span><span class="tiles-label">Tiles</span><span class="tiles-n"></span>`
  tilesBtn.title = "Every running session's chat, side by side (T)"
  tilesBtn.addEventListener("click", () => (tiles.isOpen ? tiles.close() : openTiles()))
  right.append(autoApproveToggle(store), tilesBtn)
  autoApprovedNotices(store)
  const newBtn = el("button", "new-btn") as HTMLButtonElement
  newBtn.innerHTML = `<span class="plus">+</span><span class="new-label">New session</span>`
  newBtn.title = "New session (N)"
  newBtn.addEventListener("click", () => openPicker())
  right.append(newBtn)
  const help = el("button", "icon-btn", "?") as HTMLButtonElement
  help.setAttribute("aria-label", "Keyboard shortcuts")
  help.addEventListener("click", () => toggleHelp())
  right.append(help)
  top.append(brand, search, right)

  const dock = el("div", "dock")
  const layoutSeg = segmented(LAYOUTS, LAYOUT_LABEL, layoutName, (v) => setLayout(v), "Layout")
  const spinSeg = segmented(SPINNERS, SPINNER_LABEL, spinnerStyle, (v) => setSpinner(v), "Spinner")
  // The spinner only shows on working cards, often tiny or off screen, so each
  // button previews its own animation.
  layoutSeg.group.title = "How sessions are arranged on the canvas (1–4)"
  spinSeg.group.title = "Animation shown on working sessions"
  spinSeg.group.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((b, i) => {
    b.prepend(spinner(12, "seg-spin", SPINNERS[i]))
    b.classList.add("with-spin")
  })
  dock.append(layoutSeg.group, el("span", "dock-sep"), spinSeg.group)
  root.append(top, dock)

  function setLayout(v: LayoutName) {
    layoutName = v
    root.dataset.layout = v
    layoutSeg.set(v)
    pref.set("layout", v)
    canvas.setLayout(v)
  }

  function setSpinner(v: SpinnerStyle) {
    spinnerStyle = v
    spinSeg.set(v)
    setSpinnerStyle(v)
    pref.set("spinner", v)
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => canvas.setQuery(searchInput.value), 90)
    search.classList.toggle("has-value", !!searchInput.value)
  })
  searchInput.addEventListener("keydown", (e) => {
    e.stopPropagation()
    if (e.key === "Escape") {
      if (searchInput.value) {
        searchInput.value = ""
        canvas.setQuery("")
        search.classList.remove("has-value")
      } else searchInput.blur()
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault()
      searchInput.blur()
      canvas.moveSelection(0, 1)
      if (e.key === "Enter" && canvas.selected) canvas.activate(canvas.selected)
    }
  })

  const updateStats = () => {
    const counts = store.statusCounts()
    const total = store.roots().length
    for (const [st, b] of chipEls) {
      const n = st === "review" ? counts.review + counts.failed : counts[st]
      b.querySelector(".chip-n")!.textContent = String(n)
      b.classList.toggle("zero", n === 0 && canvas.filter !== st)
      b.title = `${n} ${STATUS_LABEL[st].toLowerCase()}. Click to show only these`
    }
    stats.textContent = `${total} session${total === 1 ? "" : "s"}`
    const waiting = store.pendingPermissionCount()
    allowAll.hidden = waiting === 0
    allowAll.textContent = waiting > 1 ? `Allow all ${waiting}` : "Allow"
    const live = tiles.liveCount()
    tilesBtn.querySelector(".tiles-n")!.textContent = live ? String(live) : ""
    tilesBtn.classList.toggle("on", tiles.isOpen)
    tilesBtn.classList.toggle("live", counts.working + counts["needs-you"] > 0)
    // The tab title says what needs you, even from another tab.
    const bits: string[] = []
    if (counts["needs-you"]) bits.push(`${counts["needs-you"]} need${counts["needs-you"] === 1 ? "s" : ""} you`)
    if (counts.working) bits.push(`${counts.working} working`)
    const review = counts.review + counts.failed
    if (review) bits.push(`${review} to review`)
    const title = `${bits.length ? bits.join(" · ") + " — " : ""}Hermes Canvas`
    if (document.title !== title) document.title = title
  }
  // Relative times and the 48h review window move even without events.
  setInterval(updateStats, 30_000)
  const updateConn = (s: ConnectionState) => {
    dot.dataset.state = s
    dot.title =
      s === "live" ? `Connected to Hermes ${cfg.version ?? ""}`.trim() : s === "demo" ? "Simulated sessions" : s === "reconnecting" ? "Reconnecting…" : "Connecting…"
  }
  store.on({ structure: updateStats, cards: updateStats, connection: updateConn })
  updateConn(store.connection)

  // ---- help ----

  let helpEl: HTMLElement | undefined
  function toggleHelp() {
    if (helpEl) {
      helpEl.remove()
      helpEl = undefined
      return
    }
    helpEl = el("div", "help")
    helpEl.innerHTML = `
      <h2>Canvas</h2>
      <dl>
        <dt>Scroll · drag</dt><dd>Pan</dd>
        <dt>Pinch · ⌘/Ctrl + scroll</dt><dd>Zoom</dd>
        <dt>← ↑ → ↓</dt><dd>Move between sessions</dd>
        <dt>Enter · click</dt><dd>Open a stack or session</dd>
        <dt>Esc</dt><dd>Step back one level</dd>
        <dt>/ · ⌘K · type</dt><dd>Search</dd>
        <dt>1 – 4</dt><dd>Satellites, Fold, Tabs, Tree</dd>
        <dt>0 · double-click</dt><dd>Fit everything</dd>
        <dt>N</dt><dd>New session: pick a project or type a folder path</dd>
        <dt>T</dt><dd>Tiles: every running session's chat side by side</dd>
        <dt>] · [</dt><dd>Next / previous session that needs you, then to review, then working</dd>
      </dl>
      <h2>Status</h2>
      <dl class="legend">
        <dt><span class="mark needs-you"></span></dt><dd>Needs you: a permission or question is waiting</dd>
        <dt><span class="mark working-l"></span></dt><dd>Working: the agent is running</dd>
        <dt><span class="mark review"></span></dt><dd>To review: finished since you last opened it (48h)</dd>
        <dt><span class="mark failed"></span></dt><dd>Failed</dd>
        <dt><span class="mark stopped"></span></dt><dd>Stopped</dd>
        <dt><span class="mark done"></span></dt><dd>Done and seen</dd>
      </dl>
      <h2>Session</h2>
      <dl>
        <dt>Enter</dt><dd>Send, or steer while working</dd>
        <dt>Tab</dt><dd>Queue for after the current turn</dd>
        <dt>⇧ Enter</dt><dd>New line</dd>
        <dt>⌘ .</dt><dd>Stop</dd>
      </dl>`
    helpEl.addEventListener("click", () => toggleHelp())
    root.append(helpEl)
  }

  function jumpAttention(dir: 1 | -1) {
    const t = Date.now()
    const order: Status[] = ["needs-you", "review", "working"]
    const list = order.flatMap((st) =>
      store
        .roots()
        .filter((s) => store.inFilter(s.id, st, t) && canvas.hasSession(s.id))
        .sort((a, b) => b.time.updated - a.time.updated)
        .map((s) => s.id),
    )
    if (!list.length) return toast("Nothing needs you right now")
    const i = canvas.selected ? list.indexOf(canvas.selected) : -1
    const next = list[(i + dir + list.length) % list.length]
    canvas.select(next, false)
    canvas.centerOn(next, Math.max(0.8, canvas.camera.z))
  }

  // ---- keyboard ----

  window.addEventListener("keydown", (e) => {
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']")) return
    if (e.key === "Escape") {
      if (helpEl) return toggleHelp()
      if (picker.isOpen) return picker.close()
      if (panel.isOpen) return panel.close()
      if (tiles.isOpen) {
        if (tiles.maximized) return tiles.toggleMax(tiles.maximized)
        return tiles.close()
      }
      if (searchInput.value) {
        searchInput.value = ""
        search.classList.remove("has-value")
        return canvas.setQuery("")
      }
      if (canvas.filter) return setFilter(undefined)
      if (canvas.closeStack()) return
      return canvas.select(undefined)
    }
    if (panel.isOpen) {
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) panel.focusInput()
      return
    }
    if ((e.key === "t" || e.key === "T") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      return tiles.isOpen ? tiles.close() : openTiles()
    }
    // The canvas shortcuts below don't apply on the tiled view.
    if (tiles.isOpen) return
    if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || e.key === "/") {
      e.preventDefault()
      searchInput.focus()
      searchInput.select()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === "=" || e.key === "+") {
        e.preventDefault()
        canvas.zoomBy(1.25)
      } else if (e.key === "-") {
        e.preventDefault()
        canvas.zoomBy(0.8)
      } else if (e.key === "0") {
        e.preventDefault()
        canvas.fitAll()
      }
      return
    }
    const dirs: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }
    if (dirs[e.key]) {
      e.preventDefault()
      return canvas.moveSelection(...dirs[e.key])
    }
    if (e.key === "Enter" && canvas.selected) {
      e.preventDefault()
      return canvas.activate(canvas.selected)
    }
    if (/^[1-4]$/.test(e.key)) return setLayout(LAYOUTS[Number(e.key) - 1])
    if (e.key === "0") return canvas.fitAll()
    if (e.key === "=" || e.key === "+") return canvas.zoomBy(1.25)
    if (e.key === "-") return canvas.zoomBy(0.8)
    if (e.key === "n" || e.key === "N") {
      e.preventDefault()
      return openPicker()
    }
    if (e.key === "?") return toggleHelp()
    // Jump between sessions that want attention: needs you, then review, then working.
    if (e.key === "]" || e.key === "[") return jumpAttention(e.key === "]" ? 1 : -1)
    // Typing anywhere starts a search.
    if (e.key.length === 1 && /\S/.test(e.key)) {
      searchInput.focus()
    }
  })

  try {
    await store.start()
  } catch (e) {
    store.stop()
    if (!demo) return showUnavailable(root, { ...cfg, connected: false, error: (e as Error).message })
    throw e
  }

  // Deep links: /#tiles, /#ses_…
  const hash = location.hash.slice(1)
  if (hash === "tiles") openTiles()
  if (hash && store.sessions.has(hash)) requestAnimationFrame(() => requestAnimationFrame(() => openSession(hash)))
}

void boot()
