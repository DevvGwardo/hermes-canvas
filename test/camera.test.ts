import { describe, expect, test } from "bun:test"
import { Camera } from "../src/app/camera"

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
    // release() marks recent input; wait past the idle threshold.
    const t0 = performance.now()
    while (performance.now() - t0 < 150) {}
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
    const t0 = performance.now()
    while (performance.now() - t0 < 120) {}
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
})
