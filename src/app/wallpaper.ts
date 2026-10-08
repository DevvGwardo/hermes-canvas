// Canvas wallpaper: hermes-desk dark treatments (sky/haze/blush/linen).
// Ported from hermes-desk's chat-wallpaper pattern (ids + localStorage
// persistence), adapted to vanilla TS — no React. The classes (`wall-*`)
// are painted on `.stage`, BEHIND the GPU-composited `.world` layer, so
// pan/zoom never repaints them.

export const WALLPAPER_IDS = ["sky", "haze", "blush", "linen"] as const;
export type WallpaperId = (typeof WALLPAPER_IDS)[number];

export const WALLPAPER_DEFAULT: WallpaperId = "sky";

export const WALLPAPER_LABELS: Record<WallpaperId, string> = {
  sky: "Sky",
  haze: "Haze",
  blush: "Blush",
  linen: "Linen",
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
