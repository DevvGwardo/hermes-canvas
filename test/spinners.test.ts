import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { SPINNERS, reducedMotion, setSpinnerStyle, spinner } from "../src/app/spinners"

// Working indicators are canvas-drawn by spinners.ts's own requestAnimationFrame
// loop, which CSS cannot switch off — so the module itself must honour
// `prefers-reduced-motion` the way styles.css honours it for keyframe
// animations. These tests pin that contract: under reduce every spinner paints
// exactly one resting frame and never joins the loop, a mid-session toggle
// settles and stops (or restarts) the shared loop, and with motion allowed the
// 40fps throttle behaves as before.
//
// The describes below rely on declaration order: spinners.ts keeps
// module-level loop state (live set, running flag, throttle clock), so the
// motion-allowed cases must run after the reduced ones. Do not reorder.

type Ops = string[]

interface FakeCanvas {
  style: Record<string, string>
  dataset: Record<string, string>
  className: string
  isConnected: boolean
  offsetParent: object | null
  width: number
  height: number
  ops: Ops
  closest: (selector: string) => null
  getContext: (kind: string) => unknown
  setAttribute: (name: string, value: string) => void
}

// Append-only for the whole file: later tests drive loops and canvases that
// earlier tests created, so nothing here is reset between tests.
const canvases: FakeCanvas[] = []
const raf: Array<(now: number) => void> = []
const mediaQueries: string[] = []
let reduceFlag = false
let animated: FakeCanvas | undefined

function makeCanvas(): HTMLCanvasElement {
  const ops: Ops = []
  const ctx: Record<string, unknown> = {}
  const record =
    (name: string) =>
    (..._args: unknown[]) => {
      ops.push(name)
    }
  for (const name of ["setTransform", "clearRect", "beginPath", "arc", "stroke", "fill", "fillRect", "roundRect"]) {
    ctx[name] = record(name)
  }
  ctx.createRadialGradient = (..._args: unknown[]) => {
    ops.push("createRadialGradient")
    return { addColorStop: () => {} }
  }
  const c: FakeCanvas = {
    style: {},
    dataset: {},
    className: "",
    isConnected: true,
    offsetParent: {}, // truthy: treated as rendered, so the loop would paint it
    width: 0,
    height: 0,
    ops,
    closest: () => null,
    getContext: () => ctx,
    setAttribute: () => {},
  }
  canvases.push(c)
  return c as unknown as HTMLCanvasElement
}

const g = globalThis as Record<string, unknown>
const original = {
  document: g.document,
  window: g.window,
  requestAnimationFrame: g.requestAnimationFrame,
  matchMedia: g.matchMedia,
}

beforeEach(() => {
  reduceFlag = false
  g.document = { createElement: (tag: string) => (tag === "canvas" ? makeCanvas() : undefined) }
  g.window = { devicePixelRatio: 2 }
  g.requestAnimationFrame = (cb: (now: number) => void) => {
    raf.push(cb)
    return raf.length
  }
  g.matchMedia = (query: string) => {
    mediaQueries.push(query)
    return { matches: reduceFlag, media: query }
  }
})

const RESTORE_KEYS = ["document", "window", "requestAnimationFrame", "matchMedia"] as const

afterEach(() => {
  for (const key of RESTORE_KEYS) {
    if (original[key] === undefined) delete g[key]
    else g[key] = original[key]
  }
})

describe("reducedMotion()", () => {
  test("asks the browser for the reduce media query", () => {
    expect(reducedMotion()).toBe(false) // default stub: no preference
    expect(mediaQueries).toContain("(prefers-reduced-motion: reduce)")
  })

  test("is false when matchMedia is unavailable at all", () => {
    delete g.matchMedia
    expect(reducedMotion()).toBe(false)
  })

  test("follows the media query when the preference is set", () => {
    reduceFlag = true
    expect(reducedMotion()).toBe(true)
    reduceFlag = false
    expect(reducedMotion()).toBe(false)
  })

  test("never throws when the environment's matchMedia does", () => {
    g.matchMedia = () => {
      throw new Error("no media support")
    }
    expect(reducedMotion()).toBe(false)
  })
})

describe("spinner() under prefers-reduced-motion", () => {
  beforeEach(() => {
    reduceFlag = true
  })

  test("paints one resting frame and never starts the rAF loop", () => {
    const scheduled = raf.length
    spinner(13)
    const c = canvases[canvases.length - 1]
    expect(raf.length).toBe(scheduled) // nothing scheduled
    expect(c.width).toBeGreaterThan(0) // still sized for its devicePixelRatio
    // comet (the default style) draws: reset + clear, then 19 arc/stroke pairs
    for (const op of ["setTransform", "clearRect", "beginPath", "arc", "stroke"]) {
      expect(c.ops).toContain(op)
    }
  })

  test("pins a fixed style even when the global style differs", () => {
    spinner(12, "seg-spin", "matrix")
    const c = canvases[canvases.length - 1]
    expect(c.dataset.style).toBe("matrix")
    expect(c.ops).toContain("fillRect") // matrix draws cells…
    expect(c.ops).not.toContain("arc") // …not comet's trail
  })

  test("every style the dock offers paints without error", () => {
    // README: "customizable dock spinner animations: Wave, Matrix, Braid, Mist, or Comet"
    expect([...SPINNERS]).toEqual(["wave", "matrix", "braid", "mist", "comet"])
    for (const s of SPINNERS) {
      setSpinnerStyle(s)
      const start = canvases.length
      spinner(14)
      expect(canvases.length).toBe(start + 1)
      expect(canvases[start].ops.length).toBeGreaterThan(0)
    }
    setSpinnerStyle("comet") // leave the default for the motion-allowed cases below
  })
})

describe("spinner() with motion allowed", () => {
  test("schedules the shared loop and paints on its throttled frames", () => {
    const scheduled = raf.length
    spinner(13)
    expect(raf.length).toBe(scheduled + 1) // loop started
    const c = canvases[canvases.length - 1]

    // Below the 40fps throttle: reschedules, paints nothing.
    raf[raf.length - 1](16)
    expect(raf.length).toBe(scheduled + 2)
    expect(c.ops.length).toBe(0) // motion-on canvases are painted by the loop only

    // Past the throttle: one animated frame.
    raf[raf.length - 1](1000)
    expect(c.ops.length).toBeGreaterThan(0)

    animated = c // handed to the mid-session toggle case below
  })
})

describe("reduced motion toggled mid-session", () => {
  test("settles live spinners on their resting frame and stops scheduling", () => {
    if (!animated) throw new Error("motion-allowed case must run first")
    reduceFlag = true
    const painted = animated.ops.length
    const scheduled = raf.length
    raf[raf.length - 1](2000) // the loop's next tick notices the media query
    expect(raf.length).toBe(scheduled) // no further frame scheduled
    expect(animated.ops.length).toBeGreaterThan(painted) // settled at t = 0
  })

  test("restarts the loop for new spinners once the preference is gone", () => {
    reduceFlag = false
    const scheduled = raf.length
    spinner(13) // running was cleared by the guard above, so this restarts it
    expect(raf.length).toBe(scheduled + 1)
  })

  test("canvases created while reduced stay out of the loop entirely", () => {
    reduceFlag = true
    const frozenStart = canvases.length
    spinner(13)
    const frozen = canvases[frozenStart]
    const frozenOps = frozen.ops.length
    expect(frozenOps).toBeGreaterThan(0) // painted once, at creation

    reduceFlag = false
    const movingStart = canvases.length
    spinner(13)
    const moving = canvases[movingStart]

    const scheduled = raf.length
    raf[raf.length - 1](4000) // drive the pending tick
    expect(raf.length).toBe(scheduled + 1) // loop alive for motion-on canvases
    expect(moving.ops.length).toBeGreaterThan(0) // it joined live and got painted
    expect(frozen.ops.length).toBe(frozenOps) // it never did
  })
})

describe("disconnected canvases and loop shutdown", () => {
  test("prunes every dead canvas, stops scheduling when none remain, restarts on demand", () => {
    // Every canvas still registered from the describes above dies at once.
    for (const c of canvases) c.isConnected = false

    const frozenOps = canvases.map((c) => c.ops.length)
    const scheduled = raf.length
    raf[raf.length - 1](10_000) // reschedules first, then paintLive prunes the dead set
    expect(raf.length).toBe(scheduled + 1)
    expect(canvases.map((c) => c.ops.length)).toEqual(frozenOps) // pruned before paint: nothing drew

    raf[raf.length - 1](10_030) // next tick: live is empty now
    expect(raf.length).toBe(scheduled + 1) // stopped without scheduling another frame

    const before = raf.length
    spinner(13) // running was cleared by the guard, so this starts a fresh loop
    expect(raf.length).toBe(before + 1)
  })
})
