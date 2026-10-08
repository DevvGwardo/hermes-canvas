import { describe, expect, test } from "bun:test"
import { gridFor, projectHue } from "../src/app/tiles"

describe("tile grid", () => {
  test("one tile fills the screen", () => {
    expect(gridFor(1, 1600, 900)).toMatchObject({ cols: 1, rows: 1 })
  })

  test("a few tiles go side by side on a wide screen", () => {
    expect(gridFor(2, 1600, 900).cols).toBe(2)
    const four = gridFor(4, 1600, 900)
    expect(four.cols * four.rows).toBeGreaterThanOrEqual(4)
    expect(four.rows).toBe(2)
  })

  test("never narrower than the minimum, scrolls instead", () => {
    const g = gridFor(30, 1400, 800)
    expect((1400 - 10 * (g.cols - 1)) / g.cols).toBeGreaterThanOrEqual(360)
    expect(g.rowH).toBeGreaterThanOrEqual(300)
    expect(g.cols * g.rows).toBeGreaterThanOrEqual(30)
  })

  test("narrow screens stack", () => {
    expect(gridFor(3, 420, 900).cols).toBe(1)
  })
})

describe("project colour", () => {
  test("stable and spread out", () => {
    expect(projectHue("storefront-web")).toBe(projectHue("storefront-web"))
    const hues = new Set(["storefront-web", "mobile-app", "payments-api", "design-system", "data-pipeline", "infra"].map(projectHue))
    expect(hues.size).toBe(6)
  })
})
