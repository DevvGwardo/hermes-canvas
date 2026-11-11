// Session card DOM. Built once per card, then patched in place.

import { previewBlocks } from "./markdown"
import { spinner } from "./spinners"
import { REVIEW_WINDOW, type Status, type Store } from "./store"
import { timeAgo } from "./format"

export interface CardEls {
  root: HTMLElement
  title: HTMLElement
  body: HTMLElement
  text: HTMLElement
  bullets: HTMLElement
  status: HTMLElement
  sub: HTMLElement
  state: string
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function createSessionCard(id: string): CardEls {
  const root = el("div", "card")
  root.dataset.id = id
  root.tabIndex = -1
  root.setAttribute("role", "button")
  // Coloured top edge: the status reads even when zoomed far out.
  const accent = el("div", "card-accent")
  // The Hermes arc: an amber stroke that travels the card while it's selected.
  const arc = el("div", "card-arc")
  root.append(accent, arc)
  const title = el("div", "card-title")
  const body = el("div", "card-body")
  const text = el("p", "card-text")
  const bullets = el("ul", "card-bullets")
  body.append(text, bullets)
  const foot = el("div", "card-foot")
  const status = el("span", "card-status")
  const sub = el("span", "card-sub")
  foot.append(status, sub)
  root.append(title, body, foot)
  return { root, title, body, text, bullets, status, sub, state: "" }
}

export function createNewCard(groupKey: string): HTMLElement {
  const root = el("div", "card card-new")
  root.dataset.id = `new:${groupKey}`
  root.dataset.group = groupKey
  root.setAttribute("role", "button")
  root.innerHTML = `<span class="plus">+</span> New session`
  return root
}

const STATUSES: Status[] = ["needs-you", "working", "review", "failed", "stopped", "done"]
const STATUS_TEXT: Record<Status, string> = {
  "needs-you": "needs your input",
  working: "working",
  review: "finished, not reviewed yet",
  failed: "failed",
  stopped: "stopped",
  done: "done",
}

function setText(e: HTMLElement, v: string): boolean {
  if (e.textContent === v) return false
  e.textContent = v
  return true
}

/** Patch a card's DOM in place. Returns true when layout-affecting content changed. */
export function updateSessionCard(c: CardEls, store: Store, id: string, now = Date.now()): boolean {
  const s = store.sessions.get(id)
  if (!s) return false
  const working = store.isWorking(id)
  const ask = store.needsInput(id) ?? undefined
  const preview = store.previews.get(id)
  const live = working ? store.liveText.get(id) : undefined

  let heightChanged = c.state === ""
  if (setText(c.title, store.title(s))) heightChanged = true
  c.root.title = s.location.directory

  let body = preview?.text ?? ""
  let bullets = preview?.bullets ?? []
  let pending = false
  if (live && live.trim()) {
    const p = previewBlocks(live)
    body = p.text
    bullets = p.bullets
  } else if (preview?.pendingUser && working) {
    body = preview.pendingUser
    bullets = []
    pending = true
  }
  if (setText(c.text, body)) heightChanged = true
  if (c.text.classList.contains("pending") !== pending) {
    c.text.classList.toggle("pending", pending)
    heightChanged = true
  }
  // Fixed-height body: streaming text never changes the card's size. Before
  // the preview loads, reserve the space so the layout doesn't jump.
  const empty = !!preview && !body && !bullets.length
  if (c.body.classList.contains("empty") !== empty) {
    c.body.classList.toggle("empty", empty)
    heightChanged = true
  }
  const bulletKey = bullets.join("\u0001")
  if (c.bullets.dataset.key !== bulletKey) {
    c.bullets.dataset.key = bulletKey
    c.bullets.replaceChildren(...bullets.map((b) => el("li", "", b)))
    heightChanged = true
  }
  // Only fade the top edge when the body actually clips its first line; the
  // mask used to wash out the first line of every short preview too.
  const bodyKey = `${body}\u0000${bulletKey}\u0000${pending}\u0000${empty}`
  if (c.body.dataset.key !== bodyKey) {
    c.body.dataset.key = bodyKey
    c.body.classList.toggle(
      "clipped",
      !empty && c.body.scrollHeight > c.body.clientHeight + 1,
    )
  }

  const status = store.status(id, now)
  if ((c.root.dataset.status === "working") !== (status === "working")) heightChanged = true
  const fresh = status === "failed" && store.unseen(id) && now - (s.time.idle ?? 0) < REVIEW_WINDOW
  const state = `${status}:${ask ?? ""}:${fresh}`
  if (state !== c.state) {
    c.state = state
    c.status.replaceChildren()
    for (const st of STATUSES) c.root.classList.toggle(`st-${st}`, st === status)
    c.root.classList.toggle("fresh", fresh)
    c.root.dataset.status = status
    if (status === "working") c.status.append(spinner(13), el("span", "label"))
    else c.status.append(el("span", `mark ${status}`), el("span", "label"))
  }
  const label = c.status.querySelector<HTMLElement>(".label")!
  const ago = timeAgo(s.time.idle ?? s.time.updated, now)
  switch (status) {
    case "needs-you":
      setText(label, ask === "question" ? "Waiting for your answer" : "Needs permission")
      break
    case "working":
      setText(label, store.activityLabel(id))
      break
    case "review":
      setText(label, `Finished · ${ago}`)
      break
    case "failed":
      setText(label, `Failed · ${ago}`)
      break
    case "stopped":
      setText(label, `Stopped · ${ago}`)
      break
    default:
      setText(label, ago)
  }
  c.root.setAttribute("aria-label", `${store.title(s)}, ${STATUS_TEXT[status]}`)

  const n = store.subagentCount(id)
  setText(c.sub, n ? `${n} subagent${n === 1 ? "" : "s"}` : "")
  c.root.classList.toggle("has-sub", n > 0)
  return heightChanged
}
