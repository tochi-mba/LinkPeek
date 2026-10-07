import {afterEach, describe, expect, it, vi} from "vitest";
import type {TabStatus, TumblrJobState} from "../../src/shared/messages";
import {loadPage, settle, stubExtension, type PageHarness} from "./page-harness";

let harness: PageHarness;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const saved = () => harness.store.settings as Record<string, unknown>;
const status = (patch: Partial<TabStatus> = {}): TabStatus => ({enabled: true, mode: "auto", headroom: 1, tier: "high", prepared: 3, inspectorOpen: false, ...patch});

async function open(options: {settings?: Record<string, unknown>; url?: string | null; status?: TabStatus | "unreachable"; favorites?: unknown[]; tumblrJob?: TumblrJobState} = {}) {
  vi.resetModules();
  loadPage("popup.html");
  harness = stubExtension(options.settings ?? {}, {favorites: options.favorites ?? []});
  const url = options.url === undefined ? "https://forum.test/latest" : options.url;
  harness.chrome.tabs.query.mockResolvedValue(url === null ? [] : [{id: 7, url}]);
  harness.chrome.tabs.sendMessage.mockImplementation(async () => {
    if (options.status === "unreachable") throw new Error("No receiving end");
    return options.status ?? status();
  });
  harness.chrome.runtime.sendMessage.mockImplementation(async (message: {type: string}) => {
    harness.messages.push(message);
    if (message.type === "LINKPEEK_TUMBLR_STATUS") return options.tumblrJob;
    if (message.type === "LINKPEEK_MIRROR_QUERY") return {open: false};
    return {ok: true};
  });
  await import("../../src/pages/popup");
  await settle();
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the popup", () => {
  it("shows what LinkPeek is doing on this page", async () => {
    await open();
    expect($("#site").textContent).toBe("forum.test");
    expect($("#status").textContent).toBe("3 links ready · running at full speed on this high device");
    expect(harness.chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {type: "LINKPEEK_STATUS"});
    expect($('[data-mode="auto"]').classList.contains("active")).toBe(true);
    expect($('[data-open="hover"]').getAttribute("aria-checked")).toBe("true");
    await open({status: status({prepared: 1, reason: "the page is busy", headroom: 0.4})});
    expect($("#status").textContent).toBe("1 link ready · easing off: the page is busy");
  });

  it("explains when previews cannot run", async () => {
    await open({url: "chrome://extensions"});
    expect($("#site").textContent).toBe("Not a web page");
    expect($("#status").textContent).toBe("Previews work on web pages.");
    expect($("#pauseSite").hidden).toBe(true);
    await open({url: null});
    expect($("#site").textContent).toBe("Not a web page");
    await open({status: "unreachable"});
    expect($("#status").textContent).toBe("Reload this page to start previews here.");
    await open({settings: {enabled: false}});
    expect($("#status").textContent).toBe("LinkPeek is off.");
    expect(($("#enabled") as HTMLInputElement).checked).toBe(false);
  });

  it("says the mirror button will close the mirror while one is open", async () => {
    await open();
    expect($("#mirror").textContent).toBe("Mirror");
    vi.resetModules();
    loadPage("popup.html");
    harness = stubExtension({});
    harness.chrome.tabs.query.mockResolvedValue([]);
    harness.chrome.runtime.sendMessage.mockImplementation(async (msg: {type: string}) => msg.type === "LINKPEEK_MIRROR_QUERY" ? {open: true} : {ok: true});
    await import("../../src/pages/popup");
    await settle();
    expect($("#mirror").textContent).toBe("Close mirror");
  });

  it("opens the library, and its preloaded media directly", async () => {
    await open();
    $("#history").click();
    $("#preloaded").click();
    expect(harness.chrome.tabs.create).toHaveBeenCalledWith({url: "chrome-extension://id/history.html"});
    expect(harness.chrome.tabs.create).toHaveBeenCalledWith({url: "chrome-extension://id/history.html?view=saved&filter=unseen"});
    $("#tumblrLibrary").click();
    expect(harness.chrome.tabs.create).toHaveBeenCalledWith({url: "chrome-extension://id/history.html?view=saved"});
  });

  it("offers a whole-blog download only on Tumblr blog pages", async () => {
    await open();
    expect($<HTMLElement>("#tumblrCard").hidden).toBe(true);
    $("#tumblrAction").click();
    $("#tumblrStop").click();
    expect(harness.messages).not.toContainEqual({type: "LINKPEEK_TUMBLR_START", blog: expect.anything()});
    expect(harness.messages).not.toContainEqual({type: "LINKPEEK_TUMBLR_STOP"});

    await open({url: "https://www.tumblr.com/Some-Blog/post/1"});
    expect($<HTMLElement>("#tumblrCard").hidden).toBe(false);
    expect($("#tumblrBlog").textContent).toBe("@some-blog");
    expect($("#tumblrStatus").textContent).toContain("Download every original image");
    expect($("#tumblrAction").textContent).toBe("Download this blog");
    expect($("#tumblrPhase").textContent).toBe("Ready");
    expect($<HTMLProgressElement>("#tumblrProgress").hidden).toBe(true);

    const collecting: TumblrJobState = {blog: "some-blog", phase: "collecting", posts: 4, total: 20, found: 7, saved: 2, failed: 1, skipped: 3, collected: false};
    harness.chrome.runtime.sendMessage.mockResolvedValueOnce(collecting);
    $("#tumblrAction").click();
    await settle();
    expect(harness.chrome.runtime.sendMessage).toHaveBeenCalledWith({type: "LINKPEEK_TUMBLR_START", blog: "some-blog"});
    expect($("#tumblrStatus").textContent).toBe("Checking post 4 of 20 · 2 of 7 files saved · 3 already downloaded · 1 failed");
    expect($<HTMLProgressElement>("#tumblrProgress").value).toBe(10);
    expect([$("#tumblrAction").textContent, $<HTMLButtonElement>("#tumblrAction").disabled, $("#tumblrStop").textContent]).toEqual(["Downloading now", true, "Stop @some-blog"]);
  });

  it("shows live Tumblr progress, stops safely and offers to continue", async () => {
    const collecting: TumblrJobState = {blog: "demo", phase: "collecting", posts: 8, total: 10, found: 4, saved: 2, failed: 0, skipped: 0, collected: true};
    await open({url: "https://demo.tumblr.com", tumblrJob: collecting});
    expect($("#tumblrStatus").textContent).toBe("All posts checked · finishing downloads · 2 of 4 files saved");
    expect($<HTMLProgressElement>("#tumblrProgress").value).toBe(75);
    $("#tumblrStop").click();
    await settle();
    expect(harness.messages).toContainEqual({type: "LINKPEEK_TUMBLR_STOP"});
    expect($("#tumblrStatus").textContent).toBe("Stopping… 2 of 4 files saved");
    expect($<HTMLButtonElement>("#tumblrStop").disabled).toBe(true);

    const stopped = {...collecting, phase: "stopped" as const, collected: false};
    for (const listener of harness.storageListeners) listener({tumblrJob: {newValue: stopped}}, "session");
    expect($("#tumblrStatus").textContent).toBe("Stopped · 2 of 4 files saved");
    expect($("#tumblrAction").textContent).toBe("Continue download");
    expect($<HTMLButtonElement>("#tumblrStop").hidden).toBe(true);
  });

  it("summarises completed and failed Tumblr jobs and ignores another blog's old result", async () => {
    const base: TumblrJobState = {blog: "demo", phase: "done", posts: 10, total: 10, found: 5, saved: 4, failed: 1, skipped: 6, collected: true};
    await open({url: "https://www.tumblr.com/demo", tumblrJob: base});
    expect($("#tumblrStatus").textContent).toBe("Done · 4 of 5 files saved · 6 already downloaded · 1 failed");
    expect($("#tumblrAction").textContent).toBe("Check for new media");

    await open({url: "https://www.tumblr.com/demo", tumblrJob: {...base, phase: "failed", error: undefined, found: 0, saved: 0, skipped: 0}});
    expect($("#tumblrStatus").textContent).toBe("Couldn't finish: Tumblr stopped responding. no media found yet · 1 failed");
    expect($("#tumblrAction").textContent).toBe("Continue download");

    await open({url: "https://www.tumblr.com/other", tumblrJob: base});
    expect($("#tumblrBlog").textContent).toBe("@other");
    expect($("#tumblrStatus").textContent).toContain("Download every original image");
    for (const listener of harness.storageListeners) listener({tumblrJob: {newValue: undefined}}, "session");
    expect($("#tumblrAction").textContent).toBe("Download this blog");

    await open({url: "https://www.tumblr.com/other", tumblrJob: {...base, blog: "demo", phase: "collecting", posts: 8, total: 0, found: 0, saved: 0, failed: 0, skipped: 0, collected: false}});
    expect($("#tumblrBlog").textContent).toBe("@demo");
    expect($("#tumblrStatus").textContent).toBe("Checking post 8 · no media found yet");
    expect($("#tumblrAction").textContent).toBe("Add @other to queue");
  });

  it("queues several Tumblr blogs, shows their order, removes one and clears the waiting list", async () => {
    const collecting: TumblrJobState = {blog: "first", phase: "collecting", posts: 2, total: 10, found: 3, saved: 1, failed: 0, skipped: 0, collected: false, queue: ["second", "third"]};
    await open({url: "https://www.tumblr.com/second", tumblrJob: collecting});
    expect([$("#tumblrBlog").textContent, $("#tumblrPage").textContent, $("#tumblrPhase").textContent]).toEqual(["@first", "this page: @second", "Running"]);
    expect($("#tumblrQueue").textContent).toBe("Up next (2): 1. @second  ·  2. @third");
    expect($("#tumblrAction").textContent).toBe("Remove from queue · #1");
    harness.chrome.runtime.sendMessage.mockResolvedValueOnce({...collecting, queue: ["third"]});
    $("#tumblrAction").click();
    await settle();
    expect(harness.chrome.runtime.sendMessage).toHaveBeenCalledWith({type: "LINKPEEK_TUMBLR_REMOVE_QUEUED", blog: "second"});
    expect($("#tumblrAction").textContent).toBe("Add @second to queue");

    harness.chrome.runtime.sendMessage.mockResolvedValueOnce({...collecting, queue: []});
    $("#tumblrClearQueue").click();
    await settle();
    expect(harness.chrome.runtime.sendMessage).toHaveBeenCalledWith({type: "LINKPEEK_TUMBLR_CLEAR_QUEUE"});
    expect($<HTMLElement>("#tumblrQueue").hidden).toBe(true);
    $("#tumblrLibrary").click();
    expect(harness.chrome.tabs.create).toHaveBeenCalledWith({url: "chrome-extension://id/history.html?view=saved&q=second"});
  });

  it("keeps an active Tumblr queue controllable from an ordinary page", async () => {
    const collecting: TumblrJobState = {blog: "background-blog", phase: "collecting", posts: 2, total: 10, found: 3, saved: 1, failed: 0, skipped: 0, collected: false, queue: []};
    await open({url: "https://example.com", tumblrJob: collecting});
    expect([$<HTMLElement>("#tumblrCard").hidden, $("#tumblrBlog").textContent, $("#tumblrPage").textContent, $<HTMLButtonElement>("#tumblrAction").hidden]).toEqual([false, "@background-blog", "running in the background", true]);
    $("#tumblrLibrary").click();
    expect(harness.chrome.tabs.create).toHaveBeenCalledWith({url: "chrome-extension://id/history.html?view=saved&q=background-blog"});
    $("#tumblrStop").click();
    await settle();
    expect(harness.chrome.runtime.sendMessage).toHaveBeenCalledWith({type: "LINKPEEK_TUMBLR_STOP"});
    for (const listener of harness.storageListeners) listener({tumblrJob: {newValue: {...collecting, phase: "stopped"}}}, "session");
    const calls = harness.chrome.runtime.sendMessage.mock.calls.length;
    $("#tumblrStop").click();
    await settle();
    expect(harness.chrome.runtime.sendMessage).toHaveBeenCalledTimes(calls);
  });

  it("opens the preload inspector on the page and gets out of the way", async () => {
    await open();
    const button = $<HTMLButtonElement>("#inspector"), close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    expect([button.hidden, button.textContent, button.getAttribute("aria-pressed")]).toEqual([false, "Inspector", "false"]);
    harness.chrome.tabs.sendMessage.mockResolvedValueOnce({open: true});
    button.click();
    await settle();
    expect(harness.chrome.tabs.sendMessage).toHaveBeenLastCalledWith(7, {type: "LINKPEEK_TOGGLE_INSPECTOR"});
    expect([button.textContent, button.getAttribute("aria-pressed"), close.mock.calls.length]).toEqual(["Hide inspector", "true", 1]);
    harness.chrome.tabs.sendMessage.mockResolvedValueOnce({open: false});
    button.click();
    await settle();
    expect([button.textContent, close.mock.calls.length]).toEqual(["Inspector", 1]);
    harness.chrome.tabs.sendMessage.mockRejectedValueOnce(new Error("gone"));
    button.click();
    await settle();
    expect(button.textContent).toBe("Inspector");
    await open({status: "unreachable"});
    expect($("#inspector").hidden).toBe(true);
  });

  it("starts the shuffle on the page and closes, when the shuffle is on and the page can run it", async () => {
    await open();
    const button = $<HTMLButtonElement>("#shuffle"), close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    expect(button.hidden).toBe(false);
    harness.chrome.tabs.sendMessage.mockRejectedValueOnce(new Error("gone"));
    button.click();
    await settle();
    expect(close).not.toHaveBeenCalled();
    harness.chrome.tabs.sendMessage.mockResolvedValueOnce({started: true});
    button.click();
    await settle();
    expect(harness.chrome.tabs.sendMessage).toHaveBeenLastCalledWith(7, {type: "LINKPEEK_START_SHUFFLE"});
    expect(close).toHaveBeenCalled();
    for (const options of [{settings: {shuffleSlideshow: false}}, {status: "unreachable" as const}, {status: status({enabled: false})}]) {
      await open(options);
      expect($("#shuffle").hidden).toBe(true);
    }
  });

  it("opens the second-screen mirror and closes the toolbar popup", async () => {
    await open();
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    $("#mirror").click();
    await settle();
    expect(harness.messages).toContainEqual({type: "LINKPEEK_TOGGLE_MIRROR"});
    expect(close).toHaveBeenCalledOnce();

    harness.chrome.runtime.sendMessage.mockRejectedValueOnce(new Error("worker stopped"));
    $("#mirror").click();
    await settle();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("turns LinkPeek on and off", async () => {
    await open();
    const toggle = $<HTMLInputElement>("#enabled");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await settle();
    expect(saved()).toEqual({enabled: false});
  });

  it("pauses and resumes this site, keeping its other rules", async () => {
    await open({settings: {siteProfiles: {"forum.test": {hoverDelay: 10}}}});
    $("#pauseSite").click();
    await settle();
    expect(saved()).toEqual({siteProfiles: {"forum.test": {hoverDelay: 10, enabled: false}}});
    expect($("#status").textContent).toBe("Paused on this site.");
    expect($("#pauseSite").textContent).toBe("Resume here");
    $("#pauseSite").click();
    await settle();
    expect(saved()).toEqual({siteProfiles: {"forum.test": {hoverDelay: 10}}});
  });

  it("removes an empty rule on resume, and overrides a wildcard pause", async () => {
    await open({settings: {siteProfiles: {"forum.test": {enabled: false}}}});
    $("#pauseSite").click();
    await settle();
    expect(saved()).toEqual({});
    await open({settings: {siteProfiles: {"*.forum.test": {enabled: false}}}, url: "https://www.forum.test/"});
    expect($("#pauseSite").textContent).toBe("Resume here");
    $("#pauseSite").click();
    await settle();
    expect(saved()).toEqual({siteProfiles: {"*.forum.test": {enabled: false}, "www.forum.test": {enabled: true}}});
  });

  it("switches performance mode and opening style", async () => {
    await open();
    $('[data-mode="saver"]').click();
    $('[data-open="click"]').click();
    await settle();
    expect(saved()).toEqual({performanceMode: "saver", activationMode: "click"});
    expect($('[data-mode="saver"]').classList.contains("active")).toBe(true);
  });

  it("lists, opens and removes saved links", async () => {
    await open({favorites: [{url: "https://a.test/t/1", title: "<Thread>", addedAt: 2, mediaCount: 4}, {url: "https://b.test/x", title: "B", addedAt: 1}]});
    expect($("#favoriteCount").textContent).toBe("2");
    expect($(".favorite-open strong").textContent).toBe("<Thread>");
    expect([...document.querySelectorAll(".favorite-open small")].map(el => el.textContent)).toEqual(["a.test · 4 media", "b.test"]);
    $<HTMLButtonElement>("[data-open-favorite='1']").click();
    expect(harness.chrome.tabs.create).toHaveBeenCalledWith({url: "https://b.test/x"});
    $<HTMLButtonElement>("[data-remove-favorite='0']").click();
    await settle();
    expect($("#favoriteCount").textContent).toBe("1");
    harness.store.favorites = [];
    for (const listener of harness.storageListeners) {
      listener({favorites: {newValue: []}}, "local");
      listener({favorites: {newValue: []}}, "sync");
      listener({settings: {newValue: {}}}, "local");
    }
    await settle();
    expect($("#favorites").textContent).toContain("No saved links yet");
  });

  it("opens settings and practice, and clears the cache", async () => {
    await open();
    $("#options").click();
    expect(harness.chrome.runtime.openOptionsPage).toHaveBeenCalled();
    $("#practice").click();
    expect(harness.chrome.tabs.create).toHaveBeenCalledWith({url: "chrome-extension://id/onboarding.html"});
    $("#clear").click();
    await settle();
    expect(harness.messages).toContainEqual({type: "LINKPEEK_CLEAR_CACHE"});
    expect($("#clear").textContent).toBe("Cache cleared");
  });
});
