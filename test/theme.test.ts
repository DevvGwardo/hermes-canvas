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

function css(): Promise<string> {
  return Bun.file(new URL("../src/app/styles.css", import.meta.url)).text();
}

describe("wallpaper ids", () => {
  test("exactly amber/dither/stars/grid/void, defaulting to amber", () => {
    expect([...WALLPAPER_IDS]).toEqual(["amber", "dither", "stars", "grid", "void"]);
    expect(WALLPAPER_DEFAULT).toBe("amber");
    for (const id of WALLPAPER_IDS) expect(WALLPAPER_LABELS[id as WallpaperId]).toBeString();
  });

  test("parseWallpaper accepts known ids, falls back otherwise", () => {
    expect(parseWallpaper("dither")).toBe("dither");
    expect(parseWallpaper("stars")).toBe("stars");
    expect(parseWallpaper("void")).toBe("void");
    expect(parseWallpaper("nope")).toBe("amber");
    expect(parseWallpaper("sky")).toBe("amber"); // the old desk ids are gone
    expect(parseWallpaper(undefined)).toBe("amber");
    expect(parseWallpaper(null)).toBe("amber");
    expect(parseWallpaper(42)).toBe("amber");
  });

  test("wallpaperClass maps each id to its stage class", () => {
    expect(wallpaperClass("amber")).toBe("wall-amber");
    expect(wallpaperClass("dither")).toBe("wall-dither");
    expect(wallpaperClass("stars")).toBe("wall-stars");
    expect(wallpaperClass("grid")).toBe("wall-grid");
    expect(wallpaperClass("void")).toBe("wall-void");
  });

  test("applyWallpaper swaps exactly one wall-* class", () => {
    const f = fakeHost();
    applyWallpaper(f.host, "amber");
    expect([...f.classes]).toEqual(["wall-amber"]);
    applyWallpaper(f.host, "grid");
    expect([...f.classes]).toEqual(["wall-grid"]);
  });
});

describe("wallpaper persistence", () => {
  test("uses the hermes-canvas. localStorage prefix", () => {
    expect(WALLPAPER_KEY.startsWith("hermes-canvas.")).toBe(true);
    const store = memStore();
    saveWallpaper("stars", store);
    expect(store.dump()[WALLPAPER_KEY]).toBe("stars");
  });

  test("load/save round-trips, unknown stored values reset to amber", () => {
    const store = memStore();
    expect(loadWallpaper(store)).toBe("amber");
    saveWallpaper("dither", store);
    expect(loadWallpaper(store)).toBe("dither");
    expect(loadWallpaper(memStore("bogus"))).toBe("amber");
    expect(loadWallpaper(memStore("linen"))).toBe("amber");
    expect(loadWallpaper(null)).toBe("amber");
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
    expect(loadWallpaper(bad)).toBe("amber");
    expect(() => saveWallpaper("amber", bad)).not.toThrow();
  });
});

describe("Hermes brand tokens in styles.css", () => {
  test("the brand palette is defined (amber on warm near-black)", async () => {
    const text = await css();
    for (const token of [
      "--h-bg: #170d02",
      "--h-bg-raised: #1e1204",
      "--h-bg-panel: #241605",
      "--h-bg-inset: #100901",
      "--h-cream: #fff6e5",
      "--h-amber: #ffac02",
      "--h-amber-bright: #ffc63d",
      "--h-amber-deep: #b87c02",
      "--h-success: #4ade80",
      "--h-warning: #ffbd38",
      "--h-danger: #fb2c36",
      "--h-hairline: rgba(255, 172, 2, 0.16)",
    ]) {
      expect(text).toContain(token);
    }
  });

  test("status colours map onto the Hermes tokens", async () => {
    const text = await css();
    expect(text).toContain("--st-working: var(--h-success)");
    expect(text).toContain("--st-ask: var(--h-warning)");
    expect(text).toContain("--st-review: var(--h-amber)");
    expect(text).toContain("--st-failed: var(--h-danger)");
    expect(text).toContain("--accent: var(--h-amber)");
    expect(text).toContain("--pip-gold: var(--h-amber)");
    // The old cool-blue desk accent must not survive anywhere.
    expect(text).not.toContain("#a7ceff");
    expect(text).not.toContain("#b8d8ff");
    expect(text).not.toContain("rgba(22, 22, 22");
    expect(text).not.toContain("rgba(184, 216, 255");
  });

  test("all five wallpaper stage classes exist behind the world layer", async () => {
    const text = await css();
    for (const id of WALLPAPER_IDS) expect(text).toContain(`.stage.wall-${id}`);
    // World layer keeps its GPU-composited transform; wallpaper is stage-level.
    expect(text).toContain(".world {");
  });

  test("the Hermes design system is wired up: type, bevels, arc, dither", async () => {
    const text = await css();
    // Squared corners + hard bevels, per the DS.
    expect(text).toContain("--h-radius: 2px");
    expect(text).toContain("--h-bevel: inset 1px 1px 0 0");
    expect(text).toContain("--h-radius-pill: 2px");
    // Uppercase display utility + the travelling arc stroke.
    expect(text).toContain("text-transform: uppercase");
    expect(text).toContain("letter-spacing: 0.2em");
    expect(text).toContain("animation: hermes-arc 2.23s linear infinite");
    expect(text).toContain("repeating-conic-gradient");
    // Focus ring is brand amber now.
    expect(text).toContain("outline: 2px solid var(--desk-focus-ring)");
  });

  test("every brand font is declared and shipped", async () => {
    const text = await css();
    for (const face of ["Inter", "Oswald", "DM Serif Display", "Courier Prime"]) {
      expect(text).toContain(`font-family: "${face}"`);
    }
    for (const file of [
      "Inter-Variable.woff2",
      "Oswald-Variable.woff2",
      "DMSerifDisplay-Regular.woff2",
      "CourierPrime-Regular.woff2",
      "CourierPrime-Bold.woff2",
    ]) {
      const bytes = await Bun.file(new URL(`../assets/fonts/${file}`, import.meta.url)).arrayBuffer();
      expect(bytes.byteLength).toBeGreaterThan(1000);
    }
  });

  test("pip brand assets and the splash are wired up", async () => {
    const svg = await Bun.file(new URL("../assets/pip.svg", import.meta.url)).text();
    expect(svg).toContain("courier owl");
    const html = await Bun.file(new URL("../src/app/index.html", import.meta.url)).text();
    expect(html).toContain("assets/pip.svg");
    expect(html).toContain("<title>Hermes Canvas</title>");
    expect(html).toContain('name="theme-color" content="#170d02"');
    // The splash ships as static markup so it paints before the module loads.
    expect(html).toContain('class="boot-pip"');
    expect(html).toContain('class="boot-hermes"');
  });
});
