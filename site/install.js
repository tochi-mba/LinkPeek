/**
 * Shows the install steps that work in the visitor's browser.
 *
 * Chrome, Edge, Brave and Opera only install extensions straight from a click
 * when they come from a web store, so they get the ZIP and "Load unpacked".
 * Helium and other Chromium builds without Google's branding can install the
 * signed CRX from a click once a flag is set. Anything else is told what
 * LinkPeek needs. Without JavaScript the page keeps the ZIP steps.
 */

/** @typedef {{kind: "zip" | "click" | "unsupported", name: string, extensions?: string}} Browser */

/** @returns {Browser} */
export function detect(nav) {
  const ua = nav.userAgent || "", brands = (nav.userAgentData?.brands ?? []).map(entry => entry.brand);
  const zip = (name, extensions) => ({kind: "zip", name, extensions});
  if (nav.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(ua)) return {kind: "unsupported", name: "a phone or tablet"};
  if (!/\b(?:Chrome|Chromium)\//.test(ua)) return {kind: "unsupported", name: /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "this browser"};
  if (nav.brave) return zip("Brave", "brave://extensions");
  if (brands.includes("Microsoft Edge") || /\bEdg\//.test(ua)) return zip("Edge", "edge://extensions");
  if (brands.includes("Opera") || /\bOPR\//.test(ua)) return zip("Opera", "opera://extensions");
  if (brands.includes("Google Chrome")) return zip("Chrome", "chrome://extensions");
  const helium = brands.includes("Helium") || /\bHelium\//.test(ua);
  return {kind: "click", name: helium ? "Helium" : "Helium or Chromium", extensions: "chrome://extensions"};
}

function show(doc, kind) {
  for (const block of doc.querySelectorAll("[data-install]")) block.hidden = block.dataset.install !== kind;
}

/** Copies an address the page cannot link to (browsers block links to their own settings pages). */
async function copy(button, nav) {
  const text = button.dataset.copy || button.previousElementSibling?.textContent || "";
  try {
    await nav.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed: select it";
  }
}

/** @param {Browser} browser */
export function apply(doc, browser, nav = navigator) {
  const title = doc.querySelector("[data-install-title]");
  if (title) title.textContent = browser.kind === "unsupported" ? "LinkPeek needs a desktop Chromium browser." : `Install LinkPeek in ${browser.name}.`;
  for (const name of doc.querySelectorAll("[data-browser-name]")) name.textContent = browser.name;
  for (const page of doc.querySelectorAll("[data-extensions-page]")) page.textContent = browser.extensions ?? "chrome://extensions";
  show(doc, browser.kind);
  doc.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target.closest("[data-copy],[data-show-install]") : null;
    if (!target) return;
    if (target.dataset.showInstall) show(doc, target.dataset.showInstall);
    else void copy(target, nav);
  });
}

if (typeof document !== "undefined" && !globalThis.__LINKPEEK_INSTALL_TEST__) apply(document, detect(navigator));
