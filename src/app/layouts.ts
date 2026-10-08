// Pure layout functions: groups of cards in, world-space placements out.

import type { Rect } from "./camera"

export type LayoutName = "satellites" | "fold" | "tabs" | "tree"
export const LAYOUTS: LayoutName[] = ["satellites", "fold", "tabs", "tree"]

export const CARD_W = 300
export const NEW_CARD_H = 104
const GAP = 14
const GROUP_GAP_X = 64
const GROUP_GAP_Y = 72
const LABEL_H = 34

export interface LayoutItem {
  id: string
  kind: "session" | "new"
  h: number
  updated: number
}

export interface LayoutGroup {
  key: string
  label: string
  items: LayoutItem[] // sessions newest first; a trailing "new" item
}

export interface Placement {
  x: number // top-left of the unscaled card
  y: number
  w: number
  h: number
  scale: number
  rot: number
  z: number
  opacity: number
  interactive: boolean
}

export interface LabelPlacement {
  key: string
  text: string
  sub?: string
  x: number
  y: number
  w: number
  opacity: number
}

export interface LayoutResult {
  cards: Map<string, Placement>
  labels: LabelPlacement[]
  groups: Map<string, Rect>
  bounds: Rect
}

export interface LayoutOptions {
  expanded?: string // fold: the opened stack
  query?: (id: string) => boolean // search filter; when set, results get a flat grid
  aspect?: number // viewport width / height; rows wrap so the whole map matches it
  resultLabel?: (count: number) => string // heading for the filtered grid
}

interface Block {
  key: string
  w: number
  h: number
  place(ox: number, oy: number, out: LayoutResult): void
}

const card = (x: number, y: number, h: number, extra: Partial<Placement> = {}): Placement => ({
  x,
  y,
  w: CARD_W,
  h,
  scale: 1,
  rot: 0,
  z: 1,
  opacity: 1,
  interactive: true,
  ...extra,
})

function label(out: LayoutResult, key: string, text: string, x: number, y: number, w: number, sub?: string) {
  out.labels.push({ key, text, sub, x, y, w, opacity: 1 })
}

/** Row width that makes the packed map roughly match the screen's shape. */
function balancedWidth(blocks: Block[], aspect: number, min: number) {
  let area = 0
  let widest = 0
  for (const b of blocks) {
    area += (b.w + GROUP_GAP_X) * (b.h + GROUP_GAP_Y)
    widest = Math.max(widest, b.w)
  }
  return Math.max(widest, min, Math.sqrt(area * aspect) * 1.08)
}

/** Rows of blocks, wrapping at rowWidth; each row as tall as its tallest block. */
function shelf(blocks: Block[], aspect: number, min: number, out: LayoutResult) {
  const rowWidth = balancedWidth(blocks, aspect, min)
  let x = 0
  let y = 0
  let rowH = 0
  for (const b of blocks) {
    if (x > 0 && x + b.w > rowWidth) {
      x = 0
      y += rowH + GROUP_GAP_Y
      rowH = 0
    }
    b.place(x, y, out)
    out.groups.set(b.key, { x, y, w: b.w, h: b.h })
    x += b.w + GROUP_GAP_X
    rowH = Math.max(rowH, b.h)
  }
}

function columnsBlock(g: LayoutGroup, cols: number, rowMajor: boolean): Block {
  const items = g.items
  const colH = new Array(cols).fill(0)
  const pos: Array<{ id: string; c: number; y: number; h: number }> = []
  if (rowMajor) {
    // Grid: rows share a top edge so the reading order stays left-to-right.
    let y = 0
    for (let r = 0; r * cols < items.length; r++) {
      const row = items.slice(r * cols, r * cols + cols)
      row.forEach((it, c) => pos.push({ id: it.id, c, y, h: it.h }))
      y += Math.max(...row.map((it) => it.h)) + GAP
    }
    colH.fill(y)
  } else {
    const per = Math.ceil(items.length / cols)
    items.forEach((it, i) => {
      const c = Math.floor(i / per)
      pos.push({ id: it.id, c, y: colH[c], h: it.h })
      colH[c] += it.h + GAP
    })
  }
  const w = cols * CARD_W + (cols - 1) * GAP
  const h = LABEL_H + Math.max(0, ...colH) - GAP
  return {
    key: g.key,
    w,
    h,
    place(ox, oy, out) {
      label(out, g.key, g.label, ox, oy, w, countLabel(g))
      for (const p of pos) out.cards.set(p.id, card(ox + p.c * (CARD_W + GAP), oy + LABEL_H + p.y, p.h))
    },
  }
}

function countLabel(g: LayoutGroup) {
  const n = g.items.filter((i) => i.kind === "session").length
  return `${n} session${n === 1 ? "" : "s"}`
}

// ---- layouts ----------------------------------------------------------------

function tree(groups: LayoutGroup[], o: LayoutOptions, out: LayoutResult) {
  // Each project is a column; long projects spill into extra columns of ~6.
  const blocks = groups.map((g) => columnsBlock(g, Math.max(1, Math.ceil(g.items.length / 6)), false))
  shelf(blocks, o.aspect ?? 1.6, 1600, out)
}

function tabs(groups: LayoutGroup[], o: LayoutOptions, out: LayoutResult) {
  const blocks = groups.map((g) => columnsBlock(g, Math.min(3, g.items.length), true))
  shelf(blocks, o.aspect ?? 1.6, 2000, out)
}

const PILE_DEPTH = 4

function pileBlock(g: LayoutGroup): Block {
  const sessions = g.items.filter((i) => i.kind === "session")
  const top = sessions[0] ?? g.items[0]
  const h = LABEL_H + top.h + PILE_DEPTH * 7 + 8
  return {
    key: g.key,
    w: CARD_W,
    h,
    place(ox, oy, out) {
      label(out, g.key, g.label, ox, oy, CARD_W, countLabel(g))
      const baseY = oy + LABEL_H + PILE_DEPTH * 7
      g.items.forEach((it, i) => {
        const isNew = it.kind === "new"
        const d = isNew ? PILE_DEPTH : Math.min(i, PILE_DEPTH)
        const sign = i % 2 ? 1 : -1
        out.cards.set(
          it.id,
          card(ox, baseY - d * 7, isNew ? top.h : it.h, {
            scale: 1 - d * 0.035,
            rot: i === 0 ? 0 : sign * Math.min(d, 3) * 0.9,
            z: 100 - i,
            opacity: isNew || i > PILE_DEPTH ? 0 : 1 - d * 0.17,
            // The whole pile opens as one target.
            interactive: i === 0,
          }),
        )
      })
    },
  }
}

function fold(groups: LayoutGroup[], o: LayoutOptions, out: LayoutResult) {
  const blocks = groups.map((g) =>
    g.key === o.expanded ? columnsBlock(g, Math.min(3, g.items.length), true) : pileBlock(g),
  )
  shelf(blocks, o.aspect ?? 1.6, 1600, out)
}

const SAT_SCALE = 0.56

function satellitesBlock(g: LayoutGroup): Block {
  const sessions = g.items.filter((i) => i.kind === "session")
  const hub = sessions[0]
  const rest = sessions.slice(1)
  const rings: LayoutItem[][] = []
  let radius = 330
  const radii: number[] = []
  let i = 0
  while (i < rest.length) {
    const cap = Math.max(6, Math.floor((2 * Math.PI * radius) / (CARD_W * SAT_SCALE + 26)))
    rings.push(rest.slice(i, i + cap))
    radii.push(radius)
    i += cap
    radius += 250
  }
  const outer = radii.length ? radii[radii.length - 1] : 0
  const halfW = outer + (CARD_W * SAT_SCALE) / 2 + 20
  const halfH = outer * 0.86 + 130
  const size = { w: Math.max(CARD_W + 40, halfW * 2), h: Math.max((hub?.h ?? 200) + 60, halfH * 2) + LABEL_H }
  return {
    key: g.key,
    w: size.w,
    h: size.h,
    place(ox, oy, out) {
      const cx = ox + size.w / 2
      const cy = oy + LABEL_H + (size.h - LABEL_H) / 2
      if (hub) {
        out.cards.set(hub.id, card(cx - CARD_W / 2, cy - hub.h / 2, hub.h, { z: 50 }))
        label(out, g.key, g.label, cx - CARD_W / 2, cy - hub.h / 2 - LABEL_H, CARD_W, countLabel(g))
      }
      rings.forEach((ring, r) => {
        const R = radii[r]
        ring.forEach((it, k) => {
          // Ellipse a little flatter than a circle: screens are wide.
          const a = -Math.PI / 2 + (k / ring.length) * Math.PI * 2 + r * 0.35
          const x = cx + Math.cos(a) * R
          const y = cy + Math.sin(a) * R * 0.86
          out.cards.set(it.id, card(x - CARD_W / 2, y - it.h / 2, it.h, { scale: SAT_SCALE, z: 10 - r }))
        })
      })
      for (const it of g.items)
        if (it.kind === "new")
          out.cards.set(it.id, card(cx - CARD_W / 2, cy - NEW_CARD_H / 2, NEW_CARD_H, { opacity: 0, scale: 0.6, interactive: false, z: 0 }))
    },
  }
}

function satellites(groups: LayoutGroup[], o: LayoutOptions, out: LayoutResult) {
  shelf(groups.map(satellitesBlock), o.aspect ?? 1.6, 2400, out)
}

function searchGrid(groups: LayoutGroup[], previous: LayoutResult | undefined, o: LayoutOptions, out: LayoutResult) {
  const all = groups.flatMap((g) => g.items.filter((i) => i.kind === "session"))
  const hits = all.filter((i) => o.query!(i.id)).sort((a, b) => b.updated - a.updated)
  const cols = Math.max(1, Math.min(4, hits.length))
  const colH = new Array(cols).fill(LABEL_H)
  const heading = o.resultLabel
    ? o.resultLabel(hits.length)
    : hits.length
      ? `${hits.length} result${hits.length === 1 ? "" : "s"}`
      : "No matches"
  label(out, "__search", heading, 0, 0, CARD_W * 2)
  for (const it of hits) {
    let c = 0
    for (let k = 1; k < cols; k++) if (colH[k] < colH[c] - 1) c = k
    out.cards.set(it.id, card(c * (CARD_W + GAP), colH[c], it.h, { z: 5 }))
    colH[c] += it.h + GAP
  }
  // Everything else fades out where it stood.
  for (const g of groups)
    for (const it of g.items) {
      if (out.cards.has(it.id)) continue
      const prev = previous?.cards.get(it.id)
      out.cards.set(
        it.id,
        prev
          ? { ...prev, opacity: 0, scale: prev.scale * 0.92, interactive: false, z: 0 }
          : card(0, 0, it.h, { opacity: 0, scale: 0.9, interactive: false, z: 0 }),
      )
    }
  out.groups.set("__search", { x: 0, y: 0, w: cols * (CARD_W + GAP) - GAP, h: Math.max(...colH) })
}

export function layout(
  name: LayoutName,
  groups: LayoutGroup[],
  opts: LayoutOptions = {},
  previous?: LayoutResult,
): LayoutResult {
  const out: LayoutResult = { cards: new Map(), labels: [], groups: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } }
  if (opts.query) searchGrid(groups, previous, opts, out)
  else if (name === "tree") tree(groups, opts, out)
  else if (name === "tabs") tabs(groups, opts, out)
  else if (name === "fold") fold(groups, opts, out)
  else satellites(groups, opts, out)

  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const take = (r: Rect) => {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }
  if (opts.query) out.groups.forEach(take)
  else for (const p of out.cards.values()) if (p.opacity > 0) take(p)
  if (!opts.query) for (const l of out.labels) take({ x: l.x, y: l.y, w: l.w, h: LABEL_H })
  out.bounds = Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: CARD_W, h: 200 }
  return out
}
