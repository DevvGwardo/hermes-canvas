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
    // Covered cards become a uniform deck behind the front card, all the same
    // height, with their contents hidden by the renderer.
    expect(top.stacked).toBe(false)
    expect(under.stacked).toBe(true)
    expect(under.y).toBeGreaterThan(top.y)
    expect(under.h).toBe(top.h)
    const open = layout("fold", gs, { expanded: "g2" })
    expect(open.cards.get("g2s1")!.interactive).toBe(true)
    expect(open.cards.get("g2s1")!.x).not.toBe(open.cards.get("g2s0")!.x)
    expect(open.cards.get("g2s1")!.stacked).toBeFalsy()
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

  test("search without a previous layout fades misses from a fresh card", () => {
    const r = layout("tree", gs, { query: (id) => id.endsWith("s1") })
    const miss = r.cards.get("g0s0")! // a miss with nowhere to fade from
    expect(miss.opacity).toBe(0)
    expect(miss.scale).toBe(0.9) // a fresh fade card, not prev.scale * 0.92
    expect(miss.interactive).toBe(false)
    expect(miss.z).toBe(0)
    expect(miss.x).toBe(0)
    expect(miss.y).toBe(0)
  })

  test("empty groups in fold and tabs do not throw or return negative widths", () => {
    const emptyGroup: LayoutGroup[] = [{ key: "empty", label: "empty", items: [] }]
    for (const name of LAYOUTS) {
      const r = layout(name, emptyGroup, {})
      const box = r.groups.get("empty")
      if (box) {
        expect(box.w).toBeGreaterThan(0)
        expect(box.h).toBeGreaterThan(0)
      }
      expect(Number.isFinite(r.bounds.w) && r.bounds.w > 0).toBe(true)
      expect(Number.isFinite(r.bounds.h) && r.bounds.h > 0).toBe(true)
    }
  })

  test("searchGrid height excludes trailing GAP on hits", () => {
    const single: LayoutGroup[] = [
      { key: "g0", label: "p0", items: [{ id: "s1", kind: "session", h: 180, updated: 100 }] },
    ]
    const r = layout("tree", single, { query: () => true })
    expect(r.groups.get("__search")!.h).toBe(34 + 180) // LABEL_H + card.h, no trailing GAP
  })

  test("satellites: tall cards in dense rings do not overlap vertically", () => {
    const tall: LayoutGroup[] = [
      {
        key: "tall",
        label: "tall-project",
        items: [
          ...Array.from({ length: 14 }, (_, i) => ({ id: `t${i}`, kind: "session" as const, h: 360, updated: 100 - i })),
          { id: "new:tall", kind: "new" as const, h: 104, updated: 0 },
        ],
      },
    ]
    const r = layout("satellites", tall, {})
    const shown = [...r.cards.values()].filter((p) => p.opacity > 0)
    const scaledOverlaps = (a: Placement, b: Placement) => {
      const acx = a.x + CARD_W / 2
      const acy = a.y + a.h / 2
      const bcx = b.x + CARD_W / 2
      const bcy = b.y + b.h / 2
      const aw = a.w * a.scale
      const ah = a.h * a.scale
      const bw = b.w * b.scale
      const bh = b.h * b.scale
      return Math.abs(acx - bcx) * 2 < aw + bw && Math.abs(acy - bcy) * 2 < ah + bh
    }
    for (let i = 0; i < shown.length; i++)
      for (let j = i + 1; j < shown.length; j++) expect(scaledOverlaps(shown[i], shown[j])).toBe(false)

    // Multi-ring mixed heights (30 satellites) also separate across rings cleanly
    const mixed30: LayoutGroup[] = [
      {
        key: "m30",
        label: "mixed",
        items: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, kind: "session" as const, h: 150 + ((i * 89) % 260), updated: 1000 - i })),
      },
    ]
    const rm = layout("satellites", mixed30, {})
    const shown30 = [...rm.cards.values()].filter((p) => p.opacity > 0)
    for (let i = 0; i < shown30.length; i++)
      for (let j = i + 1; j < shown30.length; j++) expect(scaledOverlaps(shown30[i], shown30[j])).toBe(false)
  })
})
