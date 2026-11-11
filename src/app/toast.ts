let host: HTMLElement | undefined
const MAX_TOASTS = 5

function ensureHost(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined
  const body = document.body
  if (!body) return undefined
  const connected = typeof host?.isConnected === "boolean" ? host.isConnected : true
  const sameDoc =
    host && "ownerDocument" in host && (host as any).ownerDocument
      ? (host as any).ownerDocument === document
      : true
  const inBody =
    !!host &&
    (Array.isArray(body.children)
      ? body.children.includes(host)
      : host.parentElement === body || host.parentNode === body)
  if (!host || !connected || !sameDoc || !inBody) {
    host = document.createElement("div")
    host.className = "toasts"
    host.setAttribute("role", "status")
    host.setAttribute("aria-live", "polite")
    body.append(host)
  }
  return host
}

export function toast(message: string, ms = 3200) {
  const h = ensureHost()
  if (!h) return
  while (h.children.length >= MAX_TOASTS) {
    const oldest = h.children[0]
    oldest?.remove()
    if (Array.isArray(h.children) && h.children[0] === oldest) h.children.shift()
  }
  const t = document.createElement("div")
  t.className = "toast"
  t.textContent = message
  h.append(t)
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => t.classList.add("in"))
  else t.classList.add("in")
  setTimeout(() => {
    t.classList.remove("in")
    setTimeout(() => t.remove(), 300)
  }, ms)
}
