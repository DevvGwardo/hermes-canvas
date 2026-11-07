// Canvas wallpaper: Hermes-branded dark treatments (amber/dither/stars/grid/void).
//
// The palette comes from the real Hermes design system (@nous-research/ui):
// warm near-black `--h-bg` #170d02, brand amber `--h-amber` #ffac02, cream
// `--h-cream` #fff6e5. The classes (`wall-*`) are painted on `.stage`, BEHIND
// the GPU-composited `.world` layer, so pan/zoom never repaints them.

export const WALLPAPER_IDS = ["amber", "dither", "stars", "grid", "void"] as const;
export type WallpaperId = (typeof WALLPAPER_IDS)[number];

export const WALLPAPER_DEFAULT: WallpaperId = "amber";

export const WALLPAPER_LABELS: Record<WallpaperId, string> = {
  amber: "Amber",
  dither: "Dither",
  stars: "Stars",
  grid: "Grid",
  void: "Void",
};

/** Persisted under the existing `hermes-canvas.` localStorage prefix. */
export const WALLPAPER_KEY = "hermes-canvas.wallpaper";

const ID_SET: ReadonlySet<string> = new Set(WALLPAPER_IDS);

export function parseWallpaper(raw: unknown): WallpaperId {
  return typeof raw === "string" && ID_SET.has(raw) ? (raw as WallpaperId) : WALLPAPER_DEFAULT;
}

export function wallpaperClass(id: WallpaperId): string {
  return `wall-${parseWallpaper(id)}`;
}

export interface WallpaperStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): WallpaperStorage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* private mode / non-DOM (tests) */
  }
  return null;
}

export function loadWallpaper(store: WallpaperStorage | null = browserStorage()): WallpaperId {
  try {
    return parseWallpaper(store?.getItem(WALLPAPER_KEY));
  } catch {
    return WALLPAPER_DEFAULT;
  }
}

export function saveWallpaper(id: WallpaperId, store: WallpaperStorage | null = browserStorage()): void {
  const next = parseWallpaper(id);
  try {
    store?.setItem(WALLPAPER_KEY, next);
  } catch {
    /* quota / private mode — persistence is best-effort */
  }
}

export function applyWallpaper(
  host: { classList: { remove(...cls: string[]): void; add(cls: string): void } },
  id: WallpaperId,
): void {
  const next = parseWallpaper(id);
  for (const w of WALLPAPER_IDS) host.classList.remove(`wall-${w}`);
  host.classList.add(`wall-${next}`);
}
