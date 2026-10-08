let host: HTMLElement | undefined

export function toast(message: string, ms = 3200) {
  if (!host) {
    host = document.createElement("div")
    host.className = "toasts"
    host.setAttribute("role", "status")
    host.setAttribute("aria-live", "polite")
    document.body.append(host)
  }
  const t = document.createElement("div")
  t.className = "toast"
  t.textContent = message
  host.append(t)
  requestAnimationFrame(() => t.classList.add("in"))
  setTimeout(() => {
    t.classList.remove("in")
    setTimeout(() => t.remove(), 300)
  }, ms)
}
