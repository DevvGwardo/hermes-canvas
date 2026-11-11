// The global "Auto-approve" switch. Turning it on asks for a second click,
// because it lets every agent run commands and edit files without asking.

import type { Store } from "./store"
import { toast } from "./toast"
import type { PermissionRequest } from "./types"

const storeToggles = new WeakMap<Store, Set<WeakRef<HTMLButtonElement>>>()
const connectedOnce = new WeakSet<HTMLButtonElement>()
const storeWiredUnsub = new WeakMap<Store, () => void>()

function unwireIfEmpty(store: Store, refs: Set<WeakRef<HTMLButtonElement>>) {
  if (refs.size) return
  storeWiredUnsub.get(store)?.()
  storeWiredUnsub.delete(store)
}

function paintButton(store: Store, b: HTMLButtonElement) {
  b.classList.toggle("on", store.autoApproveAll)
  b.classList.remove("confirming")
  const label = b.querySelector(".aa-label")
  if (label) label.textContent = store.autoApproveAll ? "Auto-approve on" : "Auto-approve"
  b.setAttribute("aria-pressed", String(store.autoApproveAll))
  b.title = store.autoApproveAll
    ? "Approving every permission request from every session while this page is open. Click to stop."
    : "Approve every permission request automatically (while this page is open)"
}

function paint(store: Store) {
  const refs = storeToggles.get(store)
  if (!refs) return
  for (const ref of refs) {
    const b = ref.deref()
    if (!b) {
      refs.delete(ref)
      continue
    }
    if ("isConnected" in b) {
      if (b.isConnected) connectedOnce.add(b)
      else if (connectedOnce.has(b)) {
        refs.delete(ref)
        continue
      }
    }
    paintButton(store, b)
  }
  unwireIfEmpty(store, refs)
}

export function autoApproveToggle(store: Store, opts?: { signal?: AbortSignal }): HTMLButtonElement {
  const b = document.createElement("button")
  b.type = "button"
  b.className = "aa-toggle"
  b.innerHTML = `<span class="aa-dot" aria-hidden="true"></span><span class="aa-label"></span>`
  const signal = opts?.signal
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  b.addEventListener(
    "click",
    () => {
      if (signal?.aborted) return
      if (store.autoApproveAll) {
        clearTimeout(confirmTimer)
        store.setAutoApproveAll(false)
        toast("Auto-approve off: sessions will ask again")
        return paint(store)
      }
      if (!b.classList.contains("confirming")) {
        b.classList.add("confirming")
        const label = b.querySelector(".aa-label")
        if (label) label.textContent = "Click again: allow everything?"
        clearTimeout(confirmTimer)
        confirmTimer = setTimeout(() => {
          confirmTimer = undefined
          if (b.classList.contains("confirming")) paint(store)
        }, 4000)
        return
      }
      clearTimeout(confirmTimer)
      const pending = store.pendingPermissionCount()
      store.setAutoApproveAll(true)
      toast(pending ? `Auto-approve on: approved ${pending} waiting request${pending === 1 ? "" : "s"}` : "Auto-approve on")
      paint(store)
    },
    { signal },
  )
  if (signal?.aborted) {
    paintButton(store, b)
    return b
  }
  let refs = storeToggles.get(store)
  if (!refs) {
    refs = new Set()
    storeToggles.set(store, refs)
  }
  const ref = new WeakRef(b)
  refs.add(ref)
  if (!storeWiredUnsub.has(store) && typeof (store as Partial<Store>).on === "function") {
    const ws = new WeakRef(store)
    const unsub = store.on({
      autoApprove: () => {
        const cur = ws.deref()
        if (cur) paint(cur)
        else unsub()
      },
    })
    storeWiredUnsub.set(store, unsub)
  }
  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(confirmTimer)
        confirmTimer = undefined
        const curRefs = storeToggles.get(store)
        if (curRefs) {
          curRefs.delete(ref)
          unwireIfEmpty(store, curRefs)
        }
      },
      { once: true },
    )
  }
  paint(store)
  return b
}

/** Batch "approved X" notices so a burst of tool calls shows one toast. */
export function autoApprovedNotices(store: Store): () => void {
  let batch: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const prev = store.onAutoApproved
  const handler = (req: PermissionRequest) => {
    const s = store.sessions.get(req.sessionID)
    const where = s ? store.projectLabel(s) : "a session"
    const what = req.resources?.[0] ? `${req.action} ${req.resources[0]}` : req.action
    batch.push(`${what.length > 48 ? what.slice(0, 47) + "…" : what} (${where})`)
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      const out = batch
      batch = []
      if (out.length) toast(out.length === 1 ? `Auto-approved ${out[0]}` : `Auto-approved ${out.length} requests`)
    }, 600)
  }
  store.onAutoApproved = handler
  return () => {
    clearTimeout(timer)
    timer = undefined
    batch = []
    if (store.onAutoApproved === handler) store.onAutoApproved = prev
  }
}
