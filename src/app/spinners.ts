// "Living" spinners for working sessions. One rAF loop draws every visible
// spinner canvas in the current style.

export type SpinnerStyle = "wave" | "matrix" | "braid" | "mist" | "comet"
export const SPINNERS: SpinnerStyle[] = ["wave", "matrix", "braid", "mist", "comet"]

const ACCENT = [70, 211, 126] as const
const rgba = (a: number) => `rgba(${ACCENT[0]},${ACCENT[1]},${ACCENT[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`

let style: SpinnerStyle = "comet"
const live = new Set<HTMLCanvasElement>()
let running = false

export function setSpinnerStyle(s: SpinnerStyle) {
  style = s
}

/** A spinner canvas; `fixed` pins it to one style (the dock's previews). */
export function spinner(size = 14, extraClass = "", fixed?: SpinnerStyle): HTMLCanvasElement {
  const c = document.createElement("canvas")
  const dpr = Math.min(3, window.devicePixelRatio || 1)
  c.width = Math.round(size * dpr * 1.5) // headroom for zoomed-in canvases
  c.height = Math.round(size * dpr * 1.5)
  c.style.width = c.style.height = `${size}px`
  c.className = `spin ${extraClass}`.trim()
  c.setAttribute("aria-hidden", "true")
  if (fixed) c.dataset.style = fixed
  live.add(c)
  if (!running) {
    running = true
    requestAnimationFrame(loop)
  }
  return c
}

function hash(i: number) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

type Draw = (g: CanvasRenderingContext2D, t: number, s: number) => void

const draw: Record<SpinnerStyle, Draw> = {
  comet(g, t, s) {
    const c = s / 2
    const r = s * 0.36
    g.lineCap = "round"
    g.lineWidth = s * 0.11
    g.strokeStyle = rgba(0.13)
    g.beginPath()
    g.arc(c, c, r, 0, Math.PI * 2)
    g.stroke()
    const head = t * 5.2
    const tail = 2.4 + Math.sin(t * 1.7) * 0.5
    const steps = 18
    for (let i = 0; i < steps; i++) {
      const a0 = head - (tail * i) / steps
      const a1 = head - (tail * (i + 1)) / steps
      g.strokeStyle = rgba(1 - i / steps)
      g.beginPath()
      g.arc(c, c, r, a1, a0)
      g.stroke()
    }
  },
  wave(g, t, s) {
    const n = 4
    const gap = s / (n + 1)
    for (let i = 0; i < n; i++) {
      const ph = t * 7 - i * 0.8
      const k = (Math.sin(ph) + 1) / 2
      const h = s * (0.18 + 0.5 * k)
      g.fillStyle = rgba(0.35 + 0.65 * k)
      const w = s * 0.12
      const x = gap * (i + 1) - w / 2
      g.beginPath()
      g.roundRect(x, s / 2 - h / 2, w, h, w / 2)
      g.fill()
    }
  },
  matrix(g, t, s) {
    const n = 3
    const cell = s / n
    const d = cell * 0.52
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const k = Math.max(0, Math.sin(t * (3 + hash(i) * 3) + hash(i + 9) * 6.28))
        g.fillStyle = rgba(0.12 + 0.88 * k * k)
        g.fillRect(x * cell + (cell - d) / 2, y * cell + (cell - d) / 2, d, d)
      }
  },
  braid(g, t, s) {
    const c = s / 2
    const rx = s * 0.36
    const ry = s * 0.2
    for (let strand = 0; strand < 3; strand++) {
      const off = (strand * Math.PI * 2) / 3
      for (let k = 7; k >= 0; k--) {
        const a = t * 4.5 - k * 0.16 + off
        const x = c + Math.cos(a) * rx
        const y = c + Math.sin(a * 2) * ry
        const depth = (Math.sin(a) + 1) / 2
        g.fillStyle = rgba((1 - k / 8) * (0.35 + 0.65 * depth))
        g.beginPath()
        g.arc(x, y, s * (0.05 + 0.05 * depth) * (1 - k / 12), 0, Math.PI * 2)
        g.fill()
      }
    }
  },
  mist(g, t, s) {
    const c = s / 2
    for (let i = 0; i < 3; i++) {
      const a = t * (1.3 + i * 0.4) + i * 2.1
      const x = c + Math.cos(a) * s * 0.16
      const y = c + Math.sin(a * 1.3) * s * 0.16
      const r = s * (0.32 + 0.1 * Math.sin(t * 2 + i))
      const grad = g.createRadialGradient(x, y, 0, x, y, r)
      grad.addColorStop(0, rgba(0.55))
      grad.addColorStop(1, rgba(0))
      g.fillStyle = grad
      g.beginPath()
      g.arc(x, y, r, 0, Math.PI * 2)
      g.fill()
    }
  },
}

let last = 0
function loop(now: number) {
  if (!live.size) {
    running = false
    return
  }
  requestAnimationFrame(loop)
  if (now - last < 1000 / 40) return
  last = now
  const t = now / 1000
  for (const c of live) {
    if (!c.isConnected) {
      live.delete(c)
      continue
    }
    if (!c.offsetParent || c.closest(".culled")) continue
    const g = c.getContext("2d")
    if (!g) continue
    const s = c.width
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, s, s)
    draw[(c.dataset.style as SpinnerStyle | undefined) ?? style](g, t, s)
  }
}
