import {stripTrackingParams} from "./media";

export interface FavoriteLink {
  url: string;
  title: string;
  addedAt: number;
  mediaCount?: number;
}

const KEY = "favorites";

/** The identity a saved link is stored under: no fragment and no tracking parameters. */
export function favoriteKey(raw: string) {
  const url = new URL(raw);
  url.hash = "";
  return stripTrackingParams(url).href;
}

export async function loadFavorites(): Promise<FavoriteLink[]> {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const out: FavoriteLink[] = [];
  for (const value of stored) {
    if (!value || typeof value.url !== "string") continue;
    let key: string;
    try {
      key = favoriteKey(value.url);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: key,
      title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : key,
      addedAt: Number(value.addedAt) || 0,
      mediaCount: Number.isFinite(value.mediaCount) ? Number(value.mediaCount) : undefined
    });
  }
  return out.sort((a, b) => b.addedAt - a.addedAt);
}

export async function isFavorite(url: string) {
  const key = favoriteKey(url);
  return (await loadFavorites()).some(favorite => favorite.url === key);
}

export async function toggleFavorite(input: {url: string; title?: string; mediaCount?: number}): Promise<{saved: boolean; favorite?: FavoriteLink}> {
  const key = favoriteKey(input.url);
  const favorites = await loadFavorites();
  const at = favorites.findIndex(favorite => favorite.url === key);
  if (at >= 0) {
    favorites.splice(at, 1);
    await chrome.storage.local.set({[KEY]: favorites});
    return {saved: false};
  }
  const favorite: FavoriteLink = {url: key, title: input.title?.trim() || key, addedAt: Date.now(), mediaCount: input.mediaCount};
  favorites.unshift(favorite);
  await chrome.storage.local.set({[KEY]: favorites});
  return {saved: true, favorite};
}

export async function removeFavorite(url: string) {
  const key = favoriteKey(url);
  const favorites = (await loadFavorites()).filter(favorite => favorite.url !== key);
  await chrome.storage.local.set({[KEY]: favorites});
}
