import {afterEach, describe, expect, it, vi} from "vitest";
import {loadPage, settle, stubExtension, type PageHarness} from "./page-harness";

let harness: PageHarness;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const active = () => [...document.querySelectorAll(".screen")].findIndex(screen => screen.classList.contains("active"));
const selected = (group: string) => [...document.querySelectorAll<HTMLElement>(`[data-${group}].selected`)].map(el => el.dataset[group]);

async function open(settings: Record<string, unknown> = {}) {
  vi.resetModules();
  loadPage("onboarding.html");
  harness = stubExtension(settings);
  await import("../../src/pages/onboarding");
  await settle();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the first-run guide", () => {
  it("walks forward through its screens and fills the progress bar", async () => {
    await open();
    expect(document.querySelectorAll("#progress i")).toHaveLength(4);
    const next = [...document.querySelectorAll<HTMLButtonElement>(".next")];
    next[0].click();
    expect(active()).toBe(1);
    next[1].click();
    next[2].click();
    next[2].click();
    expect(active()).toBe(3);
    expect(document.querySelectorAll("#progress i.on")).toHaveLength(4);
  });

  it("previews a link on hover and closes it shortly after leaving", async () => {
    await open();
    vi.useFakeTimers();
    const link = $("#demoLink"), peek = $("#peek");
    link.dispatchEvent(new MouseEvent("mouseenter"));
    expect(peek.classList.contains("on")).toBe(true);
    link.dispatchEvent(new MouseEvent("mouseleave"));
    peek.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(600);
    expect(peek.classList.contains("on")).toBe(true);
    peek.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(500);
    expect(peek.classList.contains("on")).toBe(false);
  });

  it("starts from the saved choices and records new ones", async () => {
    await open({reverseVertical: true, activationMode: "modifier", performanceMode: "fast"});
    expect([selected("direction"), selected("open"), selected("mode")]).toEqual([["reverse"], ["modifier"], ["fast"]]);
    $('[data-direction="normal"]').click();
    $('[data-open="click"]').click();
    $('[data-mode="saver"]').click();
    expect([selected("direction"), selected("open"), selected("mode")]).toEqual([["normal"], ["click"], ["saver"]]);
    expect(harness.store.settings).toEqual({reverseVertical: true, activationMode: "modifier", performanceMode: "fast"});
  });

  it("shows a cheat sheet built from the actual keys, skipping unbound ones", async () => {
    await open({shortcuts: {slideshow: [], nextLink: ["Shift+j"]}});
    const sheet = $("#cheat").textContent!;
    expect(sheet).toContain("Shift+J");
    expect(sheet).toContain("Next prepared link");
    expect(sheet).not.toContain("Slideshow");
  });

  it("saves on finish and closes, or opens settings", async () => {
    await open();
    $('[data-mode="saver"]').click();
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    $("#finish").click();
    await settle();
    expect(harness.store.settings).toEqual({performanceMode: "saver", onboardingComplete: true});
    expect(close).toHaveBeenCalled();
    $("#settings").click();
    await settle();
    expect(harness.chrome.runtime.openOptionsPage).toHaveBeenCalled();
  });
});
