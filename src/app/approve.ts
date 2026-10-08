// The global "Auto-approve" switch. Turning it on asks for a second click,
// because it lets every agent run commands and edit files without asking.

import type { Store } from "./store"
import { toast } from "./toast"

const toggles = new Set<HTMLButtonElement>()

function paint(store: Store) {
  for (const b of toggles) {
    b.classList.toggle("on", store.autoApproveAll)
    b.classList.remove("confirming")
    b.querySelector(".aa-label")!.textContent = store.autoApproveAll ? "Auto-approve on" : "Auto-approve"
    b.setAttribute("aria-pressed", String(store.autoApproveAll))
    b.title = store.autoApproveAll
      ? "Approving every permission request from every session while this page is open. Click to stop."
      : "Approve every permission request automatically (while this page is open)"
  }
}

export function autoApproveToggle(store: Store): HTMLButtonElement {
  const b = document.createElement("button")
  b.className = "aa-toggle"
  b.innerHTML = `<span class="aa-dot" aria-hidden="true"></span><span class="aa-label"></span>`
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  b.addEventListener("click", () => {
    if (store.autoApproveAll) {
      store.setAutoApproveAll(false)
      toast("Auto-approve off: sessions will ask again")
      return paint(store)
    }
    if (!b.classList.contains("confirming")) {
      b.classList.add("confirming")
      b.querySelector(".aa-label")!.textContent = "Click again: allow everything?"
      clearTimeout(confirmTimer)
      confirmTimer = setTimeout(() => paint(store), 4000)
      return
    }
    clearTimeout(confirmTimer)
    const pending = store.pendingPermissionCount()
    store.setAutoApproveAll(true)
    toast(pending ? `Auto-approve on: approved ${pending} waiting request${pending === 1 ? "" : "s"}` : "Auto-approve on")
    paint(store)
  })
  toggles.add(b)
  paint(store)
  return b
}

/** Batch "approved X" notices so a burst of tool calls shows one toast. */
export function autoApprovedNotices(store: Store) {
  let batch: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  store.onAutoApproved = (req) => {
    const s = store.sessions.get(req.sessionID)
    const where = s ? store.projectLabel(s) : "a session"
    const what = req.resources?.[0] ? `${req.action} ${req.resources[0]}` : req.action
    batch.push(`${what.length > 48 ? what.slice(0, 47) + "…" : what} (${where})`)
    clearTimeout(timer)
    timer = setTimeout(() => {
      toast(batch.length === 1 ? `Auto-approved ${batch[0]}` : `Auto-approved ${batch.length} requests`)
      batch = []
    }, 600)
  }
}
