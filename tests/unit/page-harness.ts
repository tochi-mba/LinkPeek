/** Shared setup for the extension page tests: real page HTML and an in-memory extension storage. */
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {vi} from "vitest";
import {SETTINGS_VERSION} from "../../src/shared/settings";

export type StorageListener = (changes: Record<string, {newValue?: unknown}>, area: string) => void;

export interface PageHarness {
  store: Record<string, unknown>;
  storageListeners: StorageListener[];
  messages: unknown[];
  /** Listeners the page registered for messages from the worker. */
  runtimeListeners: Array<(msg: unknown) => void>;
  chrome: any;
}

/** Puts the body of public/<file> into the document, as the extension page would have it. */
export function loadPage(file: string) {
  const html = readFileSync(resolve("public", file), "utf8");
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)![1].replace(/<script[\s\S]*?<\/script>/gi, "");
  document.body.className = /<body[^>]*class="([^"]*)"/i.exec(html)?.[1] ?? "";
}

export function stubExtension(settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): PageHarness {
  const harness: PageHarness = {store: {settings, settingsVersion: SETTINGS_VERSION, ...extra}, storageListeners: [], messages: [], runtimeListeners: [], chrome: undefined};
  harness.chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, harness.store[key]]))),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(harness.store, values);
          for (const listener of harness.storageListeners) listener(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {newValue: value}])), "local");
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete harness.store[key];
        })
      },
      onChanged: {addListener: vi.fn((listener: StorageListener) => harness.storageListeners.push(listener))}
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://id/${path}`,
      openOptionsPage: vi.fn(async () => undefined),
      sendMessage: vi.fn(async (message: unknown) => (harness.messages.push(message), {ok: true})),
      onMessage: {addListener: vi.fn((listener: (msg: unknown) => void) => harness.runtimeListeners.push(listener))}
    },
    tabs: {
      query: vi.fn(async () => []),
      create: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined)
    }
  };
  vi.stubGlobal("chrome", harness.chrome);
  return harness;
}

/** Lets pending promise chains (storage reads, saves) settle. */
export async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}
