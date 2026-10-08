import { describe, expect, test } from "bun:test";
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
  type WallpaperId,
  type WallpaperStorage,
} from "../src/app/wallpaper";

function memStore(initial?: string | null): WallpaperStorage & { dump(): Record<string, string> } {
  const data: Record<string, string> = {};
  if (initial != null) data[WALLPAPER_KEY] = initial;
  return {
    getItem: (k: string) => (k in data ? data[k]! : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    dump: () => ({ ...data }),
  };
}

function fakeHost() {
  const classes = new Set<string>();
  return {
    classes,
    host: {
      classList: {
        remove: (...cls: string[]) => {
          for (const c of cls) classes.delete(c);
        },
        add: (c: string) => {
          classes.add(c);
        },
      },
    },
  };
}

describe("wallpaper ids", () => {
  test("exactly sky/haze/blush/linen, defaulting to sky", () => {
    expect([...WALLPAPER_IDS]).toEqual(["sky", "haze", "blush", "linen"]);
    expect(WALLPAPER_DEFAULT).toBe("sky");
    for (const id of WALLPAPER_IDS) expect(WALLPAPER_LABELS[id as WallpaperId]).toBeString();
  });

  test("parseWallpaper accepts known ids, falls back otherwise", () => {
    expect(parseWallpaper("haze")).toBe("haze");
    expect(parseWallpaper("linen")).toBe("linen");
    expect(parseWallpaper("nope")).toBe("sky");
    expect(parseWallpaper(undefined)).toBe("sky");
    expect(parseWallpaper(null)).toBe("sky");
    expect(parseWallpaper(42)).toBe("sky");
  });

  test("wallpaperClass maps each id to its stage class", () => {
    expect(wallpaperClass("sky")).toBe("wall-sky");
    expect(wallpaperClass("haze")).toBe("wall-haze");
    expect(wallpaperClass("blush")).toBe("wall-blush");
    expect(wallpaperClass("linen")).toBe("wall-linen");
  });

  test("applyWallpaper swaps exactly one wall-* class", () => {
    const f = fakeHost();
    applyWallpaper(f.host, "sky");
    expect([...f.classes]).toEqual(["wall-sky"]);
    applyWallpaper(f.host, "linen");
    expect([...f.classes]).toEqual(["wall-linen"]);
  });
});

describe("wallpaper persistence", () => {
  test("uses the hermes-canvas. localStorage prefix", () => {
    expect(WALLPAPER_KEY.startsWith("hermes-canvas.")).toBe(true);
    const store = memStore();
    saveWallpaper("blush", store);
    expect(store.dump()[WALLPAPER_KEY]).toBe("blush");
  });

  test("load/save round-trips, unknown stored values reset to sky", () => {
    const store = memStore();
    expect(loadWallpaper(store)).toBe("sky");
    saveWallpaper("haze", store);
    expect(loadWallpaper(store)).toBe("haze");
    expect(loadWallpaper(memStore("bogus"))).toBe("sky");
    expect(loadWallpaper(null)).toBe("sky");
  });

  test("a throwing store never breaks load/save", () => {
    const bad: WallpaperStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadWallpaper(bad)).toBe("sky");
    expect(() => saveWallpaper("sky", bad)).not.toThrow();
  });
});

describe("desk theme tokens in styles.css", () => {
  async function css(): Promise<string> {
    return Bun.file(new URL("../src/app/styles.css", import.meta.url)).text();
  }

  test("desk tokens are defined", async () => {
    const text = await css();
    for (const token of [
      "--desk-surface-0: #0e0e10",
      "--desk-surface-1: #161618",
      "--desk-surface-2: #1c1c1f",
      "--desk-surface-3: #2a2a2e",
      "--desk-text-primary: #f2f2f5",
      "--desk-text-secondary: #c4c4ce",
      "--desk-text-tertiary: #adadb9",
      "--desk-accent: #a7ceff",
      "--desk-accent-surface: #253347",
      "--desk-success: #a3d9b5",
      "--desk-success-surface: #24352b",
      "--desk-warn: #efc58c",
      "--desk-warn-surface: #3b3022",
      "--desk-danger: #f2a8ad",
      "--desk-danger-surface: #3c272b",
      "--desk-focus-ring: #b8d8ff",
      "--pip-gold: #e8b96e",
    ]) {
      expect(text).toContain(token);
    }
  });

  test("status colors map onto desk tokens", async () => {
    const text = await css();
    expect(text).toContain("--st-working: var(--desk-success)");
    expect(text).toContain("--st-ask: var(--desk-warn)");
    expect(text).toContain("--st-review: var(--desk-accent)");
    expect(text).toContain("--st-failed: var(--desk-danger)");
    expect(text).toContain("--st-stopped: var(--desk-text-tertiary)");
    expect(text).toContain("var(--desk-success-surface)");
    expect(text).toContain("var(--desk-warn-surface)");
    expect(text).toContain("var(--desk-accent-surface)");
    expect(text).toContain("var(--desk-danger-surface)");
  });

  test("all four wallpaper stage classes exist behind the world layer", async () => {
    const text = await css();
    for (const id of WALLPAPER_IDS) expect(text).toContain(`.stage.wall-${id}`);
    // World layer keeps its GPU-composited transform; wallpaper is stage-level.
    expect(text).toContain(".world {");
  });

  test("desk radii, font stack, and focus ring are wired up", async () => {
    const text = await css();
    expect(text).toContain("--desk-radius-sm: 8px");
    expect(text).toContain("--desk-radius-md: 12px");
    expect(text).toContain("--desk-radius-lg: 16px");
    expect(text).toContain("--desk-radius-pill: 999px");
    expect(text).toContain("SF Pro Text");
    expect(text).toContain("2px solid var(--desk-focus-ring)");
  });

  test("pip brand assets exist", async () => {
    const svg = await Bun.file(new URL("../assets/pip.svg", import.meta.url)).text();
    expect(svg).toContain("courier owl");
    const html = await Bun.file(new URL("../src/app/index.html", import.meta.url)).text();
    expect(html).toContain("assets/pip.svg");
    expect(html).toContain("<title>Hermes Canvas</title>");
  });
});
