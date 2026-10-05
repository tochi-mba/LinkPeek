import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {SETTINGS_VERSION} from "../../src/shared/settings";
import {loadPage, settle, stubExtension, type PageHarness} from "./page-harness";

let harness: PageHarness;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const field = (key: string) => $(`[data-field="${key}"]`);
const saved = () => harness.store.settings as Record<string, unknown>;

async function open(settings: Record<string, unknown> = {}, advanced: string | null = null) {
  vi.resetModules();
  loadPage("options.html");
  harness = stubExtension(settings);
  localStorage.clear();
  if (advanced !== null) localStorage.setItem("linkpeek-show-advanced", advanced);
  await import("../../src/pages/options");
  await settle();
}

function change(el: HTMLElement, value?: string | boolean) {
  if (typeof value === "boolean") (el as HTMLInputElement).checked = value;
  else if (value !== undefined) (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event("change", {bubbles: true}));
  return settle();
}
const click = async (el: Element) => {
  (el as HTMLElement).click();
  await settle();
};
const key = async (k: string, init: KeyboardEventInit = {}) => {
  document.dispatchEvent(new KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true, ...init}));
  await settle();
};

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the settings page", () => {
  it("lists the sections and hides advanced settings until asked", async () => {
    await open();
    expect([...document.querySelectorAll("#nav a")].map(a => a.textContent)).toContain("Essentials");
    expect(document.querySelector('[data-field="cancelMovePx"]')).toBeNull();
    await change($("#advanced"), true);
    expect(field("cancelMovePx").textContent).toContain("Advanced");
    expect(localStorage.getItem("linkpeek-show-advanced")).toBe("1");
    await change($("#advanced"), false);
    expect(localStorage.getItem("linkpeek-show-advanced")).toBe("0");
  });

  it("remembers the advanced view between visits and copes without local storage", async () => {
    await open({}, "1");
    expect(field("cancelMovePx")).not.toBeNull();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await open();
    await change($("#advanced"), true);
    expect(field("cancelMovePx")).not.toBeNull();
  });

  it("saves toggles, choices, selects and keywords as sparse overrides, and resets them", async () => {
    await open();
    await change(field("enabled").querySelector("input")!, false);
    expect(saved()).toEqual({enabled: false});
    expect(harness.store.settingsVersion).toBe(SETTINGS_VERSION);
    expect(field("enabled").querySelector("[data-reset]")!.hasAttribute("hidden")).toBe(false);
    await click(field("activationMode").querySelector('[data-choice-value="click"]')!);
    expect(field("activationMode").querySelector(".segment.active")!.textContent).toBe("Clicking");
    await change(field("placement").querySelector("select")!, "left");
    await change(field("activationKeywords").querySelector("textarea")!, "Gallery, photos\n gallery \n");
    expect(saved()).toMatchObject({activationMode: "click", placement: "left", activationKeywords: ["Gallery", "photos"]});
    await click(field("enabled").querySelector("[data-reset]")!);
    expect(saved()).not.toHaveProperty("enabled");
    expect(document.querySelector("#saved")!.textContent).toBe("Saved");
  });

  it("steps and clamps numbers, and shows range values as they move", async () => {
    await open();
    const hover = field("hoverDelay");
    await click(hover.querySelector('[data-step-dir="1"]')!);
    expect(saved()).toEqual({hoverDelay: 325});
    expect(hover.querySelector("input")!.value).toBe("325");
    await change(field("hoverDelay").querySelector("input")!, "99999");
    expect(field("hoverDelay").querySelector("input")!.value).toBe("2000");
    await click(field("hoverDelay").querySelector('[data-step-dir="1"]')!);
    expect(saved()).toEqual({hoverDelay: 2000});
    const range = field("navSensitivity").querySelector<HTMLInputElement>("input")!;
    range.value = "0.8";
    range.dispatchEvent(new Event("input", {bubbles: true}));
    expect(field("navSensitivity").querySelector(".value-num")!.textContent).toBe("80%");
    await change(range);
    expect(saved()).toMatchObject({navSensitivity: 0.8});
    $("#sections").dispatchEvent(new Event("input"));
  });

  it("shows plain values for non-percentage ranges", async () => {
    await open({}, "1");
    const blur = field("transparency").querySelector<HTMLInputElement>("input")!;
    blur.value = "0.3";
    blur.dispatchEvent(new Event("input", {bubbles: true}));
    expect(field("transparency").querySelector(".value-num")!.textContent).toBe("30%");
  });

  it("searches across every section, including advanced settings", async () => {
    await open();
    const search = $<HTMLInputElement>("#search");
    search.value = "momentum";
    search.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("[data-field]")).toHaveLength(2);
    search.value = "zzzz";
    search.dispatchEvent(new Event("input"));
    expect($("#sections").textContent).toContain("No setting matches");
    search.value = "";
    search.dispatchEvent(new Event("input"));
  });

  it("resets one section without touching the others", async () => {
    await open({hoverDelay: 50, blur: 3, enabled: false});
    expect(document.querySelector('[data-section="essentials"] .modified')).not.toBeNull();
    await click($('[data-reset-section="essentials"]'));
    expect(saved()).toEqual({blur: 3});
    expect(document.querySelector("#saved")!.textContent).toBe("Section reset");
  });

  it("clears the saved note after a moment", async () => {
    await open();
    vi.useFakeTimers({shouldAdvanceTime: true});
    await change(field("enabled").querySelector("input")!, false);
    vi.advanceTimersByTime(1200);
    expect(document.querySelector("#saved")!.textContent).toBe("");
  });

  it("ignores changes from elements that are not settings", async () => {
    await open();
    const stray = document.createElement("input");
    $("#sections").append(stray);
    await change(stray, "x");
    await click($("#sections"));
    expect(saved()).toEqual({});
  });
});

describe("the shortcut editor", () => {
  const row = (label: string) => [...document.querySelectorAll(".shortcut-row")].find(el => el.querySelector(".shortcut-label")!.textContent === label)!;

  it("records a pressed key, moving it from the action that had it", async () => {
    await open();
    await click(row("Slideshow").querySelector("[data-record]")!);
    expect(row("Slideshow").textContent).toContain("Press keys");
    await key("Shift");
    await key("g");
    expect(saved()).toEqual({shortcuts: {grid: [], slideshow: ["s", "g"]}});
    expect(document.querySelector("#saved")!.textContent).toContain("Moved G");
    expect(row("Grid / single media").textContent).toContain("No key");
    await click(row("Slideshow").querySelector("[data-record]")!);
    await key("k", {ctrlKey: true});
    expect((saved().shortcuts as Record<string, string[]>).slideshow).toEqual(["s", "g", "Ctrl+k"]);
  });

  it("cancels recording with Escape or the button, and ignores keys when not recording", async () => {
    await open();
    await key("x");
    await click(row("Pin open").querySelector("[data-record]")!);
    await key("Escape");
    expect(row("Pin open").textContent).not.toContain("Press keys");
    await click(row("Pin open").querySelector("[data-record]")!);
    await click(row("Pin open").querySelector("[data-cancel-record]")!);
    expect(saved()).toEqual({});
  });

  it("removes a key, resets an action and stops offering + at four keys", async () => {
    await open({shortcuts: {help: ["a", "b", "c", "d"]}});
    expect(row("Show controls").querySelector("[data-record]")).toBeNull();
    await click(row("Next media").querySelector('[data-combo="Space"]')!);
    expect((saved().shortcuts as Record<string, string[]>).next).toEqual(["ArrowDown", "ArrowRight"]);
    await click(row("Next media").querySelector("[data-reset-shortcut]")!);
    expect(saved().shortcuts).toEqual({help: ["a", "b", "c", "d"]});
  });
});

describe("site rules", () => {
  it("pauses a site from a typed address, toggles and removes it", async () => {
    await open();
    const form = $<HTMLFormElement>("[data-site-form]");
    (form.elements.namedItem("host") as HTMLInputElement).value = "https://Forum.Example.com:8080/t/1?x#y";
    form.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true}));
    await settle();
    expect(saved()).toEqual({siteProfiles: {"forum.example.com": {enabled: false}}});
    expect($(".site-row").textContent).toContain("paused");
    await click($("[data-site-toggle]"));
    expect(saved()).toEqual({siteProfiles: {"forum.example.com": {enabled: true}}});
    expect($(".site-row").textContent).toContain("No changes");
    await click($("[data-site-toggle]"));
    await click($("[data-site-remove]"));
    expect(saved()).toEqual({});
    expect($(".site-empty")).not.toBeNull();
  });

  it("rejects addresses that are not sites", async () => {
    await open();
    const form = $<HTMLFormElement>("[data-site-form]"), input = form.elements.namedItem("host") as HTMLInputElement;
    input.value = "not a site!";
    form.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true}));
    await settle();
    expect(input.classList.contains("invalid")).toBe(true);
    expect(saved()).toEqual({});
  });

  it("describes custom rules and edits them as JSON in advanced view", async () => {
    await open({siteProfiles: {"*.forum.test": {hoverDelay: 100, blur: 2}, "one.test": {hoverDelay: 5}}}, "1");
    expect([...document.querySelectorAll(".site-row small")].map(el => el.textContent)).toEqual(["2 custom settings", "1 custom setting"]);
    const json = $<HTMLTextAreaElement>("[data-sites-json]");
    await change(json, "{oops");
    expect(json.classList.contains("invalid")).toBe(true);
    await change($("[data-sites-json]"), JSON.stringify({"x.test": {enabled: false}}));
    expect(saved()).toEqual({siteProfiles: {"x.test": {enabled: false}}});
  });

  it("ignores other forms", async () => {
    await open();
    const form = document.createElement("form");
    $("#sections").append(form);
    form.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true}));
    await settle();
    expect(saved()).toEqual({});
  });
});

describe("your data", () => {
  it("exports the changed settings as a file", async () => {
    await open({hoverDelay: 77});
    const createObjectURL = vi.fn(() => "blob:settings"), revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {configurable: true, value: createObjectURL});
    Object.defineProperty(URL, "revokeObjectURL", {configurable: true, value: revokeObjectURL});
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    $("#export").click();
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    // jsdom's Blob has no text(); FileReader reads it the old way.
    const text = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(JSON.parse(text)).toEqual({linkpeek: SETTINGS_VERSION, settings: {hoverDelay: 77}});
    expect(clicked).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:settings");
    delete (URL as Partial<typeof URL>).createObjectURL;
    delete (URL as Partial<typeof URL>).revokeObjectURL;
  });

  it("imports exported files and raw settings, rejecting anything else", async () => {
    await open();
    const input = $<HTMLInputElement>("#import");
    const pick = async (text: string) => {
      // A file as the browser hands it over; jsdom's File lacks text().
      Object.defineProperty(input, "files", {configurable: true, value: [{name: "s.json", text: async () => text}]});
      input.dispatchEvent(new Event("change"));
      await settle();
    };
    await pick(JSON.stringify({linkpeek: 2, settings: {hoverDelay: 42, bogus: 1}}));
    expect(saved()).toEqual({hoverDelay: 42});
    expect(document.querySelector("#saved")!.textContent).toBe("Settings imported");
    await pick(JSON.stringify({blur: 9}));
    expect(saved()).toEqual({blur: 9});
    await pick("not json");
    expect(document.querySelector("#saved")!.textContent).toContain("not a LinkPeek settings file");
    Object.defineProperty(input, "files", {configurable: true, value: []});
    input.dispatchEvent(new Event("change"));
  });

  it("resets everything after confirming, keeping the finished guide", async () => {
    await open({hoverDelay: 5, onboardingComplete: true});
    vi.stubGlobal("confirm", vi.fn(() => false));
    $("#resetAll").click();
    await settle();
    expect(saved()).toEqual({hoverDelay: 5, onboardingComplete: true});
    vi.stubGlobal("confirm", vi.fn(() => true));
    $("#resetAll").click();
    await settle();
    expect(saved()).toEqual({onboardingComplete: true});
  });

  it("opens the practice guide", async () => {
    await open();
    const location = {href: ""};
    vi.stubGlobal("location", location);
    $("#tutorial").click();
    expect(location.href).toBe("chrome-extension://id/onboarding.html");
  });
});

describe("live updates", () => {
  it("re-renders for changes made in the popup, but not for its own saves or other keys", async () => {
    await open();
    const renderedBefore = $("#sections").innerHTML;
    for (const listener of harness.storageListeners) {
      listener({favorites: {newValue: []}}, "local");
      listener({settings: {newValue: {enabled: false}}}, "sync");
      listener({settings: {newValue: {}}}, "local");
    }
    expect($("#sections").innerHTML).toBe(renderedBefore);
    for (const listener of harness.storageListeners) listener({settings: {newValue: {enabled: false}}}, "local");
    expect(field("enabled").querySelector("input")!.checked).toBe(false);
  });
});
