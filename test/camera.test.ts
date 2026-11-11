import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Camera } from "../src/app/camera"

let fakeNow = 10_000
const realNow = performance.now.bind(performance)

beforeEach(() => {
  fakeNow = 10_000
  performance.now = () => fakeNow
})

afterEach(() => {
  performance.now = realNow
})

function cam() {
  const c = new Camera(() => {})
  c.setViewport(1000, 800)
  c.setBounds({ x: 0, y: 0, w: 2000, h: 1000 })
  c.jumpTo(1000, 500, 1)
  return c
}

function settle(c: Camera, seconds = 3) {
  for (let i = 0; i < seconds * 60; i++) c.step(1 / 60)
}

describe("camera", () => {
  test("pans 1:1 inside the bounds", () => {
    const c = cam()
    c.panBy(100, -50)
    expect(c.cx).toBeCloseTo(1100)
    expect(c.cy).toBeCloseTo(450)
  })

  test("past an edge each step shows less, capped at 14% of the screen", () => {
    const c = cam()
    // Centre may sit up to 240 past the content edge before resistance starts.
    const edge = 2000 + 240
    c.jumpTo(edge, 500, 1)
    const steps: number[] = []
    let last = c.cx
    for (let i = 0; i < 40; i++) {
      c.panBy(100, 0)
      steps.push(c.cx - last)
      last = c.cx
    }
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThan(steps[i - 1] + 1e-9)
    expect(c.cx - edge).toBeLessThan(0.14 * 1000)
    expect(c.cx - edge).toBeGreaterThan(0.1 * 1000)
  })

  test("springs back after release", () => {
    const c = cam()
    c.jumpTo(2240, 500, 1)
    for (let i = 0; i < 10; i++) c.panBy(200, 0)
    c.release(0, 0)
    // release() marks recent input; advance past the idle threshold without busy-waiting.
    fakeNow += 150
    settle(c)
    expect(c.cx).toBeCloseTo(2240, 0)
  })

  test("zoom keeps the point under the cursor fixed", () => {
    const c = cam()
    const before = c.toWorld(800, 200)
    c.zoomAt(1.5, 800, 200)
    const after = c.toWorld(800, 200)
    expect(after.x).toBeCloseTo(before.x, 3)
    expect(after.y).toBeCloseTo(before.y, 3)
    expect(c.z).toBeCloseTo(1.5)
  })

  test("animateTo reaches its target", () => {
    const c = cam()
    c.animateTo(300, 200, 0.5, 100)
    fakeNow += 120
    c.step(1 / 60)
    expect(c.cx).toBeCloseTo(300)
    expect(c.cy).toBeCloseTo(200)
    expect(c.z).toBeCloseTo(0.5)
  })

  test("fit chooses a zoom that contains the rect", () => {
    const c = cam()
    const z = c.fitZoom({ x: 0, y: 0, w: 4000, h: 1000 }, 50, 1)
    expect(4000 * z).toBeLessThanOrEqual(1000 - 100 + 1e-6)
  })

  // ---- T32: the render-mapping and input-state gaps -------------------------
})

describe("camera — screen mapping and visibility", () => {
  test("toScreen inverts toWorld and centres the current view", () => {
    const c = cam() // centre (1000, 500), z=1, viewport 1000x800
    expect(c.toScreen(1000, 500)).toEqual({ x: 500, y: 400 })
    expect(c.toScreen(1100, 550)).toEqual({ x: 600, y: 450 })
    const p = c.toWorld(123, 456)
    expect(c.toScreen(p.x, p.y)).toEqual({ x: 123, y: 456 }) // exact round trip
  })

  test("transform names translate3d + scale and matches the state", () => {
    const c = cam()
    expect(c.transform()).toBe("translate3d(-500px, -100px, 0) scale(1)")
    c.jumpTo(1000, 500, 2)
    // z is exp(log(2)) so parse instead of comparing the string to floats.
    const parts = c
      .transform()
      .match(/^translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\((-?[\d.]+)\)$/)!
      .slice(1)
      .map(Number)
    expect(parts[0]).toBeCloseTo(-1500) // 1000/2 - cx*z
    expect(parts[1]).toBeCloseTo(-600) // 800/2 - cy*z
    expect(parts[2]).toBeCloseTo(2)
  })

  test("visibleWorld covers the viewport, expanded by the margin", () => {
    const c = cam() // z=1
    expect(c.visibleWorld()).toEqual({ x: 500, y: 100, w: 1000, h: 800 })
    expect(c.visibleWorld(50)).toEqual({ x: 450, y: 50, w: 1100, h: 900 })
    c.jumpTo(1000, 500, 2) // z=2 halves the visible world
    const r = c.visibleWorld()
    expect(r.x).toBeCloseTo(750)
    expect(r.y).toBeCloseTo(300)
    expect(r.w).toBeCloseTo(500)
    expect(r.h).toBeCloseTo(400)
    expect(c.fitZoom({ x: 0, y: 0, w: 1e6, h: 1e6 })).toBe(c.minZoom) // never below minZoom
  })
})

describe("camera — moving, hold and fit", () => {
  test("onChange fires once per programmatic move, not for setters", () => {
    let n = 0
    const c = new Camera(() => n++)
    c.setViewport(1000, 800)
    c.setBounds({ x: 0, y: 0, w: 2000, h: 1000 })
    expect(n).toBe(0) // setup does not invalidate
    c.panBy(10, 0)
    c.zoomAt(2, 500, 400)
    c.jumpTo(1000, 500, 1)
    c.animateTo(1000, 500, 1)
    expect(n).toBe(4)
  })

  test("moving is false at rest and true while held, flung or out of range", () => {
    const c = cam()
    c["lastInput"] = -Infinity // pretend the last input was long ago
    expect(c.moving).toBe(false) // fresh, centred, no velocity, not outside
    c.hold()
    expect(c.moving).toBe(true) // holding
    c.release(300, 0)
    expect(c.moving).toBe(true) // velocity over the threshold

    const flung = cam()
    flung.jumpTo(4000, 500, 1) // past the right edge; jumpTo does not touch lastInput
    expect(flung.moving).toBe(true) // outside() keeps the camera awake

    const zoomedOut = cam()
    zoomedOut.jumpTo(1000, 500, 0.001) // log zoom far below minZoom
    expect(zoomedOut.moving).toBe(true) // out-of-range zoom also counts
  })

  test("hold freezes the view and kills momentum", () => {
    const c = cam()
    c.release(300, 0)
    expect(c.step(1 / 10)).toBe(true) // the fling advances the centre
    const x = c.cx
    c.hold()
    expect(c.step(1 / 10)).toBe(true) // still active while held...
    expect(c.cx).toBe(x) // ...but nothing moves (momentum zeroed)
  })

  test("fit animates by default and jumps when animate=false", () => {
    const target = { x: 0, y: 0, w: 400, h: 200 }
    const jumpy = cam()
    jumpy.fit(target, 64, 1, false)
    expect(jumpy.cx).toBeCloseTo(200)
    expect(jumpy.cy).toBeCloseTo(100)
    expect(jumpy.z).toBe(1) // fitZoom capped at maxZoom

    const tweened = cam()
    tweened.fit(target, 64, 1) // animate defaults true
    expect(tweened.cx).toBe(1000) // untouched until the first step...
    expect(tweened.moving).toBe(true) // ...and the tween keeps it awake
  })

  test("guards invalid zoomAt factors, zero-duration tweens, non-finite inputs, and narrow fitZoom", () => {
    const c = cam()
    const before = { cx: c.cx, cy: c.cy, z: c.z }
    c.zoomAt(0, 500, 400)
    c.zoomAt(-2, 500, 400)
    c.zoomAt(NaN, 500, 400)
    c.zoomAt(Infinity, 500, 400)
    c.panBy(NaN, 10)
    c.jumpTo(NaN, 0, 1)
    c.jumpTo(0, 0, 0)
    c.setViewport(0, 800)
    expect({ cx: c.cx, cy: c.cy, z: c.z }).toEqual(before)

    // dur <= 0 jumps immediately without NaN division
    c.animateTo(400, 300, 0.8, 0)
    c.step(1 / 60)
    expect(c.cx).toBeCloseTo(400)
    expect(c.cy).toBeCloseTo(300)
    expect(c.z).toBeCloseTo(0.8)

    // Narrow viewport with large pad (e.g. closeStack pad=120 at 200px wide) never collapses to minZoom
    c.setViewport(200, 600)
    const zNarrow = c.fitZoom({ x: 0, y: 0, w: 300, h: 200 }, 120, 1)
    expect(zNarrow).toBeGreaterThan(c.minZoom)
    expect(zNarrow).toBeCloseTo(40 / 300, 4)
  })

  test("step snaps rlz cleanly when zoom settles back into range", () => {
    const c = cam()
    c.jumpTo(1000, 500, 0.02) // slightly below minZoom (0.04)
    fakeNow += 200
    settle(c, 5)
    expect(c.z).toBeCloseTo(c.minZoom, 6)
    expect(c.moving).toBe(false)
  })
})
