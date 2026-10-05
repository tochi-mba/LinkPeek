import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {MAX_HTML_BYTES, readTextCapped, scanGeneric} from "../../src/core/generic";
import {DEFAULT_SETTINGS, resolveSettings, type LinkPeekSettings} from "../../src/shared/settings";

type Route = (init: RequestInit) => Response | Promise<Response>;
const routes = new Map<string, Route>();
const calls: Array<{url: string; init: RequestInit}> = [];

function respond(url: string, body: BodyInit | null, type = "text/html", status = 200, headers: Record<string, string> = {}) {
  const response = new Response(body, {status, headers: type ? {"content-type": type, ...headers} : headers});
  Object.defineProperty(response, "url", {value: url});
  return response;
}

function html(url: string, markup: string) {
  routes.set(url, () => respond(url, markup));
}

const settings = (patch: Partial<LinkPeekSettings> = {}) => resolveSettings({...patch});

beforeEach(() => {
  routes.clear();
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({url, init});
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const route = routes.get(url);
    return route ? route(init) : respond(url, "missing", "text/html", 404);
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reading a page", () => {
  it("extracts posted media and the title from HTML", async () => {
    html("https://a.test/post", `<title>  A   post </title><img src="/one.jpg"><img src="/two.png">`);
    const result = await scanGeneric("https://a.test/post", settings());
    expect(result).toMatchObject({kind: "generic", title: "A post", complete: true, diagnostics: {adapter: "Generic HTML", ignored: 0}});
    expect(result.items.map(item => item.originalUrl)).toEqual(["https://a.test/one.jpg", "https://a.test/two.png"]);
    expect(calls[0].init).toMatchObject({credentials: "include", redirect: "follow", referrerPolicy: "same-origin"});
  });

  it("recognizes direct image, GIF and video responses without reading their bodies", async () => {
    routes.set("https://a.test/img", () => respond("https://cdn.test/final.png", "x", "image/png"));
    routes.set("https://a.test/gif", () => respond("https://cdn.test/final.gif", "x", "image/gif"));
    routes.set("https://a.test/vid", () => respond("https://cdn.test/final.mp4", "x", "video/mp4"));
    expect(await scanGeneric("https://a.test/img", settings())).toMatchObject({kind: "direct-image", items: [{type: "image", originalUrl: "https://cdn.test/final.png", filename: "final.png"}]});
    expect((await scanGeneric("https://a.test/gif", settings())).items[0].type).toBe("gif");
    expect(await scanGeneric("https://a.test/vid", settings())).toMatchObject({kind: "direct-video", items: [{type: "video"}]});
    expect(await scanGeneric("https://a.test/vid", settings({includeVideo: false}))).toMatchObject({kind: "direct-video", items: []});
  });

  it("never reads downloads or other non-page bodies", async () => {
    routes.set("https://a.test/file", () => respond("https://a.test/file", "%PDF", "application/pdf"));
    const result = await scanGeneric("https://a.test/file", settings());
    expect(result.items).toEqual([]);
    expect(result.diagnostics!.adapter).toBe("Generic HTML");
  });

  it("treats a missing content type as a page", async () => {
    // A byte body carries no automatic content type, unlike a string body.
    routes.set("https://a.test/untyped", () => respond("https://a.test/untyped", new TextEncoder().encode(`<img src="/u.jpg">`), ""));
    expect((await scanGeneric("https://a.test/untyped")).items).toHaveLength(1);
  });

  it("reports HTTP errors", async () => {
    await expect(scanGeneric("https://a.test/missing", settings())).rejects.toThrow("HTTP 404");
  });

  it("maps referrer and redirect preferences onto the request", async () => {
    html("https://a.test/r", "");
    await scanGeneric("https://a.test/r", settings({referrerPolicy: "never", followRedirects: false, recursiveSearch: "off"}));
    await scanGeneric("https://a.test/r", settings({referrerPolicy: "default", recursiveSearch: "off"}));
    expect(calls.map(call => [call.init.referrerPolicy, call.init.redirect])).toEqual([["no-referrer", "manual"], [undefined, "follow"]]);
  });

  it("gives up on a slow page after the timeout", async () => {
    vi.useFakeTimers();
    routes.set("https://a.test/slow", init => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
    const pending = expect(scanGeneric("https://a.test/slow", settings({fetchTimeout: 1000}))).rejects.toThrow("Aborted");
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
  });

  it("stops at once when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(scanGeneric("https://a.test/x", settings(), controller.signal)).rejects.toThrow("Aborted");
  });
});

describe("reading capped text", () => {
  it("stops reading past the limit and keeps what was read", async () => {
    const chunk = new TextEncoder().encode("a".repeat(1024));
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({pull: controller => {
      pulls++;
      controller.enqueue(chunk);
    }});
    const text = await readTextCapped(respond("https://a.test/", stream), 4096);
    expect(text).toHaveLength(4096);
    expect(pulls).toBeLessThan(10);
    expect(MAX_HTML_BYTES).toBe(3 * 1024 * 1024);
  });

  it("decodes the declared charset and falls back to UTF-8 for unknown ones", async () => {
    const latin = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    expect(await readTextCapped(respond("https://a.test/", latin, "text/html; charset=iso-8859-1"))).toBe("café");
    expect(await readTextCapped(respond("https://a.test/", "plain", "text/html; charset=nonsense"))).toBe("plain");
    expect(await readTextCapped(respond("https://a.test/", null))).toBe("");
  });
});

describe("searching linked pages", () => {
  const index = "https://a.test/index";

  it("follows same-site links in parallel only when the page has no media", async () => {
    html(index, `<title>Index</title>
      <a href="/album/1?utm_source=x&amp;b=2&amp;a=1#frag">1</a><a href="/album/2">2</a><a href="/album/1?a=1&b=2">dup</a>
      <a href="https://other.test/album">cross</a><a href="/file.zip">zip</a><a href="/logout">out</a><a download href="/d">dl</a>
      <a rel="nofollow" href="/nf">nf</a><a href="https://user:pw@a.test/secret">creds</a><a href="mailto:x@a.test">mail</a><a href="http://[bad">bad</a>`);
    html("https://a.test/album/1?a=1&b=2", `<img src="/p1.jpg">`);
    html("https://a.test/album/2", `<img src="/p2.jpg"><img src="/p1.jpg">`);
    const result = await scanGeneric(index, settings());
    expect(result.items.map(item => new URL(item.originalUrl).pathname)).toEqual(["/p1.jpg", "/p2.jpg"]);
    expect(result.diagnostics).toMatchObject({adapter: "Generic linked-page search", duplicates: 1});
    expect(calls.map(call => call.url)).toEqual([index, "https://a.test/album/1?a=1&b=2", "https://a.test/album/2"]);
  });

  it("keeps link order for root and recursively fetched child pages", async () => {
    html(index, `<a href="/child">child</a><a href="/root-next">root next</a>`);
    html("https://a.test/child", `<img src="/photo.jpg"><a href="/child-a">A</a><a href="/child-b">B</a><a href="/logout">unsafe</a>`);
    html("https://a.test/root-next", "");
    html("https://a.test/child-a", "");
    html("https://a.test/child-b", "");
    const result = await scanGeneric(index, settings({recursiveMaxDepth: 1, recursiveMaxPages: 3}));
    expect(result.items.map(item => item.sourceUrl)).toEqual(["https://a.test/child"]);
    expect(result.linkContexts).toEqual([
      {sourceUrl: index, links: ["https://a.test/child", "https://a.test/root-next"]},
      {sourceUrl: "https://a.test/child", links: ["https://a.test/child-a", "https://a.test/child-b"]},
      {sourceUrl: "https://a.test/root-next", links: []}
    ]);
  });

  it("goes deeper level by level, honouring the page limit and counting failures", async () => {
    html(index, `<a href="/l1">l1</a><a href="/broken">broken</a><a href="/away">away</a>`);
    html("https://a.test/l1", `<a href="/img.png">img</a><a href="/l2">l2</a><a href="/l2b">l2b</a>`);
    html("https://a.test/l2", `<img src="/deep.jpg">`);
    routes.set("https://a.test/away", () => respond("https://elsewhere.test/away", `<img src="/x.jpg">`));
    routes.set("https://a.test/img.png", () => respond("https://a.test/img.png", "x", "image/png"));
    const result = await scanGeneric(index, settings({recursiveMaxDepth: 2, recursiveMaxPages: 6}));
    expect(result.items.map(item => new URL(item.originalUrl).pathname)).toEqual(["/img.png", "/deep.jpg"]);
    // Six pages: the index, three links, then two of the next level; /l2b is past the budget.
    expect(result.diagnostics!.warnings).toContain("Skipped 2 linked pages that could not be read.");
    const limited = await scanGeneric(index, settings({recursiveMaxDepth: 2, recursiveMaxPages: 2}));
    expect(limited).toMatchObject({items: [], diagnostics: {adapter: "Generic linked-page search"}});
  });

  it("can cross sites without sending cookies, and can always search", async () => {
    html(index, `<img src="/own.jpg"><a href="https://other.test/g">g</a>`);
    html("https://other.test/g", `<img src="/other.jpg">`);
    expect((await scanGeneric(index, settings({recursiveSearch: "all"}))).items).toHaveLength(1);
    const always = await scanGeneric(index, settings({recursiveSearch: "all", recursiveTrigger: "always"}));
    expect(always.items).toHaveLength(2);
    expect(calls.find(call => call.url === "https://other.test/g")!.init.credentials).toBe("omit");
  });

  it("reports a single skipped page in the singular and stops at the media cap", async () => {
    html(index, `<a href="/a">a</a><a href="/missing">m</a><a href="/b">b</a>`);
    html("https://a.test/a", `<img src="/1.jpg"><img src="/2.jpg">`);
    html("https://a.test/b", `<img src="/3.jpg">`);
    const result = await scanGeneric(index, settings({maxMediaItems: 2, maxRequests: 1}));
    expect(result.items).toHaveLength(2);
    expect(result.diagnostics!.warnings).toEqual(["Stopped at the configured 2 media limit.", "Skipped 1 linked page that could not be read."]);
  });

  it("does not search when there is a single-page budget", async () => {
    html(index, `<a href="/a">a</a>`);
    expect((await scanGeneric(index, settings({recursiveMaxPages: 1}))).items).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("passes cancellation through to linked pages", async () => {
    const controller = new AbortController();
    html(index, `<a href="/a">a</a>`);
    routes.set("https://a.test/a", () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(scanGeneric(index, settings(), controller.signal)).rejects.toThrow("Aborted");
  });
});

describe("the page preview picture", () => {
  const empty = "https://a.test/empty";
  beforeEach(() => html(empty, `<meta property="og:image" content="/cover.jpg"><a href="/nothing">n</a>`));

  it("is used when nothing else is found", async () => {
    const result = await scanGeneric(empty, settings());
    expect(result.items.map(item => item.originalUrl)).toEqual(["https://a.test/cover.jpg"]);
    expect(result.diagnostics!.adapter).toBe("Page preview image");
    expect((await scanGeneric(empty, settings({recursiveSearch: "off"}))).items).toHaveLength(1);
  });

  it("is held back from a quick check while a linked-page search is still to come", async () => {
    expect((await scanGeneric(empty, settings(), undefined, false)).items).toEqual([]);
    expect((await scanGeneric(empty, {...DEFAULT_SETTINGS, recursiveSearch: "off"}, undefined, false)).items).toHaveLength(1);
  });
});
