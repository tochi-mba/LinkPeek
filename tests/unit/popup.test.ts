import {afterEach, describe, expect, it, vi} from "vitest";
import type {TabStatus} from "../../src/shared/messages";
import {loadPage, settle, stubExtension, type PageHarness} from "./page-harness";

let harness: PageHarness;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const saved = () => harness.store.settings as Record<string, unknown>;
const status = (patch: Partial<TabStatus> = {}): TabStatus => ({enabled: true, mode: "auto", headroom: 1, tier: "high", prepared: 3, inspectorOpen: false, ...patch});

async function open(options: {settings?: Record<string, unknown>; url?: string | null; status?: TabStatus | "unreachable"; favorites?: unknown[]} = {}) {
  vi.resetModules();
  loadPage("popup.html");
  harness = stubExtension(options.settings ?? {}, {favorites: options.favorites ?? []});
  const url = options.url === undefined ? "https://forum.test/latest" : options.url;
  harness.chrome.tabs.query.mockResolvedValue(url === null ? [] : [{id: 7, url}]);
  harness.chrome.tabs.sendMessage.mockImplementation(async () => {
    if (options.status === "unreachable") throw new Error("No receiving end");
    return options.status ?? status();
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
