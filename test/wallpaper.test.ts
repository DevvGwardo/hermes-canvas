import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  WALLPAPER_DEFAULT,
  WALLPAPER_IDS,
  WALLPAPER_KEY,
  WALLPAPER_LABELS,
  applyWallpaper,
  loadWallpaper,
  parseWallpaper,
  saveWallpaper,
  wallpaperClass,
} from "../src/app/wallpaper"

const g = globalThis as Record<string, unknown>
let savedLS: unknown

beforeEach(() => {
  savedLS = g.localStorage
})

afterEach(() => {
  if (savedLS === undefined) delete g.localStorage
  else g.localStorage = savedLS
})

describe("wallpaper module", () => {
  test("exports valid ids, labels, parseWallpaper fallback, and classes", () => {
    expect(WALLPAPER_DEFAULT).toBe("amber")
    for (const id of WALLPAPER_IDS) {
      expect(parseWallpaper(id)).toBe(id)
      expect(wallpaperClass(id)).toBe(`wall-${id}`)
      expect(WALLPAPER_LABELS[id].length).toBeGreaterThan(0)
    }
    expect(parseWallpaper("invalid")).toBe("amber")
    expect(parseWallpaper(null)).toBe("amber")
    expect(wallpaperClass("bogus" as any)).toBe("wall-amber")
  })

  test("loadWallpaper and saveWallpaper use browser localStorage by default when available", () => {
    const map = new Map<string, string>()
    g.localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    }
    expect(loadWallpaper()).toBe("amber")
    saveWallpaper("grid")
    expect(map.get(WALLPAPER_KEY)).toBe("grid")
    expect(loadWallpaper()).toBe("grid")

    // Unknown value resets safely to default.
    map.set(WALLPAPER_KEY, "nonexistent")
    expect(loadWallpaper()).toBe("amber")

    // Saving an invalid id normalizes to default.
    saveWallpaper("invalid" as any)
    expect(map.get(WALLPAPER_KEY)).toBe("amber")
  })

  test("loadWallpaper and saveWallpaper survive missing or throwing global localStorage", () => {
    delete g.localStorage
    expect(loadWallpaper()).toBe("amber")
    expect(() => saveWallpaper("void")).not.toThrow()

    Object.defineProperty(g, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError")
      },
    })
    expect(loadWallpaper()).toBe("amber")
    expect(() => saveWallpaper("stars")).not.toThrow()
    // Restore configurable property before afterEach
    delete g.localStorage
  })

  test("applyWallpaper replaces previous wall-* class with the parsed one", () => {
    const classes = new Set<string>(["stage", "wall-amber", "wall-stars"])
    const host = {
      classList: {
        remove: (...cls: string[]) => cls.forEach((c) => classes.delete(c)),
        add: (c: string) => void classes.add(c),
      },
    }
    applyWallpaper(host, "dither")
    expect([...classes]).toEqual(["stage", "wall-dither"])
    applyWallpaper(host, "bogus" as any)
    expect([...classes]).toEqual(["stage", "wall-amber"])
  })
})
