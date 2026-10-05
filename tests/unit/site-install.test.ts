import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

type Nav = {userAgent: string; userAgentData?: {brands: Array<{brand: string}>; mobile?: boolean}; brave?: unknown; clipboard?: {writeText: (text: string) => Promise<void>}};
let install: {detect: (nav: Nav) => {kind: string; name: string; extensions?: string}; apply: (doc: Document, browser: unknown, nav?: Nav) => void};

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const desktop = (brands: string[], extra: Partial<Nav> = {}, ua = CHROME_UA): Nav => ({userAgent: ua, userAgentData: {brands: brands.map(brand => ({brand})), mobile: false}, ...extra});
const visible = () => [...document.querySelectorAll<HTMLElement>("[data-install]")].filter(block => !block.hidden).map(block => block.dataset.install);

beforeAll(async () => {
  (globalThis as {__LINKPEEK_INSTALL_TEST__?: boolean}).__LINKPEEK_INSTALL_TEST__ = true;
  // @ts-expect-error -- the site serves this file as plain JavaScript, without type declarations.
  install = await import("../../site/install.js");
});
beforeEach(() => {
  const html = readFileSync(resolve("site/index.html"), "utf8");
  document.documentElement.innerHTML = html.slice(html.indexOf("<head>"));
});

describe("browser detection", () => {
  it("sends Chrome, Edge, Brave and Opera to the ZIP, with their own extensions page", () => {
    expect(install.detect(desktop(["Google Chrome", "Chromium"]))).toEqual({kind: "zip", name: "Chrome", extensions: "chrome://extensions"});
    expect(install.detect(desktop(["Microsoft Edge", "Chromium"]))).toMatchObject({name: "Edge", extensions: "edge://extensions"});
    expect(install.detect(desktop([], {}, `${CHROME_UA} Edg/141.0`))).toMatchObject({name: "Edge"});
    expect(install.detect(desktop(["Google Chrome"], {brave: {}}))).toMatchObject({name: "Brave", extensions: "brave://extensions"});
    expect(install.detect(desktop(["Opera"]))).toMatchObject({name: "Opera", extensions: "opera://extensions"});
    expect(install.detect(desktop([], {}, `${CHROME_UA} OPR/120.0`))).toMatchObject({name: "Opera"});
  });

  it("offers click-to-install to Helium and other unbranded Chromium builds", () => {
    expect(install.detect(desktop(["Helium", "Chromium"]))).toEqual({kind: "click", name: "Helium", extensions: "chrome://extensions"});
    expect(install.detect(desktop([], {}, `${CHROME_UA} Helium/0.5`))).toMatchObject({kind: "click", name: "Helium"});
    expect(install.detect(desktop(["Chromium", "Not.A/Brand"]))).toMatchObject({kind: "click", name: "Helium or Chromium"});
    expect(install.detect({userAgent: CHROME_UA})).toMatchObject({kind: "click"});
  });

  it("tells phones, Firefox and Safari what LinkPeek needs", () => {
    expect(install.detect({...desktop(["Google Chrome"]), userAgentData: {brands: [], mobile: true}})).toEqual({kind: "unsupported", name: "a phone or tablet"});
    expect(install.detect({userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148"}).name).toBe("a phone or tablet");
    expect(install.detect({userAgent: "Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0"}).name).toBe("Firefox");
    expect(install.detect({userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"}).name).toBe("Safari");
    expect(install.detect({userAgent: "Lynx/2.9"}).name).toBe("this browser");
  });
});

describe("the install section", () => {
  it("keeps the ZIP steps without JavaScript", () => {
    expect(visible()).toEqual(["zip"]);
  });

  it("shows the steps for the detected browser, and the ZIP when asked", () => {
    install.apply(document, {kind: "click", name: "Helium", extensions: "chrome://extensions"});
    expect(visible()).toEqual(["click"]);
    expect(document.querySelector("[data-install-title]")!.textContent).toBe("Install LinkPeek in Helium.");
    expect(document.querySelector('[data-install="click"] [data-browser-name]')!.textContent).toBe("Helium");
    expect(document.querySelector<HTMLAnchorElement>("[data-requires-flag]")!.getAttribute("href")).toBe("downloads/LinkPeek.crx");
    document.querySelector<HTMLButtonElement>('[data-install="click"] [data-show-install="zip"]')!.click();
    expect(visible()).toEqual(["zip"]);
  });

  it("names the browser's own extensions page, and says when the browser cannot run LinkPeek", () => {
    install.apply(document, {kind: "zip", name: "Edge", extensions: "edge://extensions"});
    expect([document.querySelector("[data-extensions-page]")!.textContent, document.querySelector("[data-install-title]")!.textContent]).toEqual(["edge://extensions", "Install LinkPeek in Edge."]);
    install.apply(document, {kind: "unsupported", name: "Firefox"});
    expect(visible()).toEqual(["unsupported"]);
    expect(document.querySelector("[data-install-title]")!.textContent).toBe("LinkPeek needs a desktop Chromium browser.");
    expect(document.querySelector("[data-extensions-page]")!.textContent).toBe("chrome://extensions");
  });

  it("copies the addresses a page cannot link to", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    install.apply(document, {kind: "click", name: "Helium"}, {userAgent: CHROME_UA, clipboard: {writeText}});
    const [pageButton, flagButton] = [...document.querySelectorAll<HTMLButtonElement>("[data-copy]")];
    flagButton.click();
    pageButton.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText.mock.calls.map(([text]) => text)).toEqual(["chrome://flags/#extension-mime-request-handling", "chrome://extensions"]);
    expect(flagButton.textContent).toBe("Copied");
    writeText.mockRejectedValueOnce(new Error("denied"));
    flagButton.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(flagButton.textContent).toBe("Copy failed: select it");
    document.querySelector("main")!.click();
  });
});
