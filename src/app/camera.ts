// Pan/zoom camera with momentum and an elastic edge.
//
// Past an edge, each step of a pan or zoom shows less of the input: the
// overshoot approaches 14% of the screen instead of growing without bound.
// Momentum dies quickly once it carries the view past an edge, and on release
// the view is pulled back with an exponential ease.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const OVERSHOOT = 0.14
const ZOOM_OVERSHOOT = 0.18 // in log-zoom units
const FRICTION = 4.2 // 1/s, inside bounds
const EDGE_FRICTION = 22 // 1/s, past an edge
const SPRING_BACK = 11 // 1/s

const rubber = (excess: number, limit: number) => limit * (1 - 1 / ((excess * 0.55) / limit + 1))

function elastic(v: number, lo: number, hi: number, limit: number) {
  if (lo > hi) lo = hi = (lo + hi) / 2
  if (v < lo) return lo - rubber(lo - v, limit)
  if (v > hi) return hi + rubber(v - hi, limit)
  return v
}

const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)))

interface Tween {
  from: { cx: number; cy: number; lz: number }
  to: { cx: number; cy: number; lz: number }
  t0: number
  dur: number
}

export class Camera {
  // Raw (unclamped) state: centre of the screen in world units and log zoom.
  private rcx = 0
  private rcy = 0
  private rlz = 0
  private vx = 0
  private vy = 0
  private tween?: Tween
  private holding = false
  private lastInput = 0

  minZoom = 0.04
  maxZoom = 2.4
  bounds: Rect = { x: 0, y: 0, w: 1, h: 1 }
  viewport = { w: 1, h: 1 }

  // Displayed state, recomputed each frame.
  cx = 0
  cy = 0
  z = 1

  constructor(private onChange: () => void) {}

  get moving() {
    return (
      !!this.tween ||
      this.holding ||
      Math.abs(this.vx) + Math.abs(this.vy) > 0.5 ||
      performance.now() - this.lastInput < 160 ||
      this.outside()
    )
  }

  private outside() {
    const [lo, hi] = this.zoomRange()
    if (this.rlz < lo - 1e-4 || this.rlz > hi + 1e-4) return true
    const b = this.centerRange(Math.exp(this.rlz))
    return this.rcx < b.x0 - 0.5 || this.rcx > b.x1 + 0.5 || this.rcy < b.y0 - 0.5 || this.rcy > b.y1 + 0.5
  }

  private zoomRange(): [number, number] {
    return [Math.log(this.minZoom), Math.log(this.maxZoom)]
  }

  /** Where the screen centre may sit: anywhere over the content. */
  private centerRange(z: number) {
    const padX = Math.min(this.viewport.w / z / 2 - 40 / z, 240)
    const padY = Math.min(this.viewport.h / z / 2 - 40 / z, 200)
    const b = this.bounds
    return {
      x0: b.x - Math.max(0, padX),
      x1: b.x + b.w + Math.max(0, padX),
      y0: b.y - Math.max(0, padY),
      y1: b.y + b.h + Math.max(0, padY),
    }
  }

  private recompute() {
    const [zlo, zhi] = this.zoomRange()
    const lz = elastic(this.rlz, zlo, zhi, ZOOM_OVERSHOOT)
    this.z = Math.exp(lz)
    const r = this.centerRange(this.z)
    this.cx = elastic(this.rcx, r.x0, r.x1, (OVERSHOOT * this.viewport.w) / this.z)
    this.cy = elastic(this.rcy, r.y0, r.y1, (OVERSHOOT * this.viewport.h) / this.z)
  }

  // ---- coordinate helpers ---------------------------------------------------

  toScreen(x: number, y: number) {
    return { x: (x - this.cx) * this.z + this.viewport.w / 2, y: (y - this.cy) * this.z + this.viewport.h / 2 }
  }

  toWorld(sx: number, sy: number) {
    return { x: (sx - this.viewport.w / 2) / this.z + this.cx, y: (sy - this.viewport.h / 2) / this.z + this.cy }
  }

  visibleWorld(margin = 0): Rect {
    const w = this.viewport.w / this.z
    const h = this.viewport.h / this.z
    return { x: this.cx - w / 2 - margin, y: this.cy - h / 2 - margin, w: w + margin * 2, h: h + margin * 2 }
  }

  transform() {
    const tx = this.viewport.w / 2 - this.cx * this.z
    const ty = this.viewport.h / 2 - this.cy * this.z
    return `translate3d(${tx}px, ${ty}px, 0) scale(${this.z})`
  }

  // ---- input --------------------------------------------------------------

  private touch() {
    this.tween = undefined
    this.lastInput = performance.now()
  }

  /** Pan by a screen-space delta (trackpad scroll or drag). */
  panBy(dxScreen: number, dyScreen: number) {
    this.touch()
    // Raw position moves 1:1; the displayed position is the rubber-banded view
    // of it, so past an edge each step shows less of the input.
    this.rcx += dxScreen / this.z
    this.rcy += dyScreen / this.z
    this.recompute()
    this.onChange()
  }

  zoomAt(factor: number, sx: number, sy: number) {
    this.touch()
    const anchor = this.toWorld(sx, sy)
    this.rlz += Math.log(factor)
    this.recompute()
    // Keep the world point under the cursor fixed.
    const after = this.toWorld(sx, sy)
    this.rcx += anchor.x - after.x
    this.rcy += anchor.y - after.y
    this.recompute()
    this.onChange()
  }

  hold() {
    this.holding = true
    this.vx = this.vy = 0
    this.touch()
  }

  release(vxScreen: number, vyScreen: number) {
    this.holding = false
    this.vx = vxScreen / this.z
    this.vy = vyScreen / this.z
    this.lastInput = performance.now()
  }

  // ---- programmatic -------------------------------------------------------

  animateTo(cx: number, cy: number, z: number, dur = 520) {
    this.vx = this.vy = 0
    this.holding = false
    const [zlo, zhi] = this.zoomRange()
    this.tween = {
      from: { cx: this.cx, cy: this.cy, lz: Math.log(this.z) },
      to: { cx, cy, lz: clamp(Math.log(z), zlo, zhi) },
      t0: performance.now(),
      dur,
    }
    this.rcx = this.cx
    this.rcy = this.cy
    this.rlz = Math.log(this.z)
    this.onChange()
  }

  jumpTo(cx: number, cy: number, z: number) {
    this.tween = undefined
    this.rcx = cx
    this.rcy = cy
    this.rlz = Math.log(z)
    this.recompute()
    this.onChange()
  }

  fitZoom(r: Rect, pad = 64, maxZoom = 1) {
    const zx = (this.viewport.w - pad * 2) / Math.max(r.w, 1)
    const zy = (this.viewport.h - pad * 2) / Math.max(r.h, 1)
    return Math.max(this.minZoom, Math.min(maxZoom, zx, zy))
  }

  fit(r: Rect, pad = 64, maxZoom = 1, animate = true) {
    const z = this.fitZoom(r, pad, maxZoom)
    if (animate) this.animateTo(r.x + r.w / 2, r.y + r.h / 2, z)
    else this.jumpTo(r.x + r.w / 2, r.y + r.h / 2, z)
  }

  setBounds(b: Rect) {
    this.bounds = b
    this.recompute()
  }

  setViewport(w: number, h: number) {
    this.viewport = { w, h }
    this.recompute()
  }

  /** Advance physics; returns true while anything is still moving. */
  step(dt: number): boolean {
    if (this.tween) {
      const t = Math.min(1, (performance.now() - this.tween.t0) / this.tween.dur)
      const e = 1 - Math.pow(1 - t, 4) // easeOutQuart
      const { from, to } = this.tween
      this.rcx = from.cx + (to.cx - from.cx) * e
      this.rcy = from.cy + (to.cy - from.cy) * e
      this.rlz = from.lz + (to.lz - from.lz) * e
      if (t >= 1) this.tween = undefined
      this.recompute()
      return true
    }
    if (this.holding) return true

    let active = false
    const r = this.centerRange(this.z)
    const outX = this.rcx < r.x0 || this.rcx > r.x1
    const outY = this.rcy < r.y0 || this.rcy > r.y1

    if (Math.abs(this.vx) + Math.abs(this.vy) > 0.5) {
      this.rcx += this.vx * dt
      this.rcy += this.vy * dt
      this.vx *= Math.exp(-(outX ? EDGE_FRICTION : FRICTION) * dt)
      this.vy *= Math.exp(-(outY ? EDGE_FRICTION : FRICTION) * dt)
      active = true
    } else {
      this.vx = this.vy = 0
    }

    // Spring back once the user lets go.
    const idle = performance.now() - this.lastInput > 120
    if (idle) {
      const k = 1 - Math.exp(-SPRING_BACK * dt)
      const [zlo, zhi] = this.zoomRange()
      const tz = clamp(this.rlz, zlo, zhi)
      if (Math.abs(tz - this.rlz) > 1e-4) {
        // Zoom back around the screen centre.
        this.rlz += (tz - this.rlz) * k
        active = true
      }
      const rr = this.centerRange(Math.exp(this.rlz))
      const tx = clamp(this.rcx, rr.x0, rr.x1)
      const ty = clamp(this.rcy, rr.y0, rr.y1)
      if (Math.abs(tx - this.rcx) > 0.3 || Math.abs(ty - this.rcy) > 0.3) {
        this.rcx += (tx - this.rcx) * k
        this.rcy += (ty - this.rcy) * k
        active = true
      } else if (!active) {
        this.rcx = tx
        this.rcy = ty
      }
    } else active = true

    this.recompute()
    return active
  }
}
