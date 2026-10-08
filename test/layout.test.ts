import { describe, expect, test } from "bun:test"
import { CARD_W, LAYOUTS, layout, type LayoutGroup, type Placement } from "../src/app/layouts"

function groups(sizes: number[]): LayoutGroup[] {
  return sizes.map((n, g) => ({
    key: `g${g}`,
    label: `project-${g}`,
    items: [
      ...Array.from({ length: n }, (_, i) => ({ id: `g${g}s${i}`, kind: "session" as const, h: 150 + ((i * 37) % 90), updated: 1000 - i })),
      { id: `new:g${g}`, kind: "new" as const, h: 104, updated: 0 },
    ],
  }))
}

const overlaps = (a: Placement, b: Placement) =>
  a.x < b.x + b.w * b.scale && b.x < a.x + a.w * a.scale && a.y < b.y + b.h && b.y < a.y + a.h

describe("layouts", () => {
  const gs = groups([1, 4, 13, 2, 7, 30])

  for (const name of LAYOUTS) {
    test(`${name}: places every card with finite coordinates`, () => {
      const r = layout(name, gs, { aspect: 1.6 })
      const ids = gs.flatMap((g) => g.items.map((i) => i.id))
      for (const id of ids) {
        const p = r.cards.get(id)
        expect(p).toBeDefined()
        expect(Number.isFinite(p!.x) && Number.isFinite(p!.y)).toBe(true)
      }
      expect(r.bounds.w).toBeGreaterThan(0)
      expect(r.labels.length).toBe(gs.length)
    })
  }

  for (const name of ["tree", "tabs"] as const) {
    test(`${name}: visible cards never overlap`, () => {
      const r = layout(name, gs, { aspect: 1.6 })
      const shown = [...r.cards.values()].filter((p) => p.opacity > 0)
      for (let i = 0; i < shown.length; i++)
        for (let j = i + 1; j < shown.length; j++) expect(overlaps(shown[i], shown[j])).toBe(false)
    })
  }

  test("rows wrap so the map roughly matches the screen", () => {
    const many = groups(Array.from({ length: 60 }, (_, i) => 1 + (i % 5)))
    const wide = layout("tree", many, { aspect: 2 }).bounds
    const tall = layout("tree", many, { aspect: 0.6 }).bounds
    expect(wide.w / wide.h).toBeGreaterThan(tall.w / tall.h)
    expect(wide.w / wide.h).toBeGreaterThan(1)
  })

  test("fold: piles show only the top card as a target; opening one lays it out", () => {
    const closed = layout("fold", gs, {})
    const top = closed.cards.get("g2s0")!
    const under = closed.cards.get("g2s1")!
    expect(top.interactive).toBe(true)
    expect(under.interactive).toBe(false)
    expect(under.x).toBe(top.x)
    const open = layout("fold", gs, { expanded: "g2" })
    expect(open.cards.get("g2s1")!.interactive).toBe(true)
    expect(open.cards.get("g2s1")!.x).not.toBe(open.cards.get("g2s0")!.x)
  })

  test("satellites: hub at full size, others orbit smaller", () => {
    const r = layout("satellites", gs, {})
    expect(r.cards.get("g5s0")!.scale).toBe(1)
    expect(r.cards.get("g5s3")!.scale).toBeLessThan(1)
  })

  test("search: hits in a flat grid newest first, misses fade in place", () => {
    const prev = layout("tree", gs, {})
    const r = layout("tree", gs, { query: (id) => id.endsWith("s1") }, prev)
    const hits = [...r.cards.entries()].filter(([, p]) => p.opacity > 0)
    expect(hits.length).toBe(gs.filter((g) => g.items.length > 2).length)
    const miss = r.cards.get("g0s0")!
    expect(miss.opacity).toBe(0)
    expect(miss.x).toBe(prev.cards.get("g0s0")!.x)
    expect(r.labels[0].text).toMatch(/results?$/)
    for (const [, p] of hits) expect(p.x % (CARD_W + 14)).toBe(0)
  })
})
