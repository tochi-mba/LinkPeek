import {vi} from "vitest";

/** A small Cache Storage stand-in (jsdom has none): named caches of responses by address. */
export function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = vi.fn(async (name: string) => {
    let store = stores.get(name);
    if (!store) stores.set(name, store = new Map());
    const entries = store;
    return {
      put: vi.fn(async (url: string, response: Response) => void entries.set(url, response)),
      match: vi.fn(async (url: string) => entries.get(url)?.clone()),
      delete: vi.fn(async (url: string) => entries.delete(url))
    };
  });
  const api = {open, delete: vi.fn(async (name: string) => stores.delete(name)), stores};
  vi.stubGlobal("caches", api);
  return api;
}
