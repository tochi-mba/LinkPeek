/** The first-run guide: try a preview, pick a scroll direction, an opening style and a performance mode. */
import {escapeHtml} from "../shared/dom";
import {DEFAULT_SETTINGS, loadSettings, saveSettings, type LinkPeekSettings, type ShortcutAction} from "../shared/settings";
import {comboLabel} from "../shared/shortcuts";

let settings: LinkPeekSettings = DEFAULT_SETTINGS;
let step = 0;

const screens = [...document.querySelectorAll<HTMLElement>(".screen")];
const progress = document.getElementById("progress")!;

const CHEAT_SHEET: Array<[string, string]> = [["Hover", "Preview"], ["Scroll ↕", "Previous / next"], ["Pinch", "Zoom"], ["Double-click", "Zoom here"]];
const CHEAT_KEYS: Array<[ShortcutAction, string]> = [["grid", "Grid"], ["nextLink", "Next prepared link"], ["slideshow", "Slideshow"], ["help", "All controls"]];

function show(target: number) {
  step = Math.max(0, Math.min(screens.length - 1, target));
  screens.forEach((screen, i) => screen.classList.toggle("active", i === step));
  [...progress.children].forEach((dot, i) => dot.classList.toggle("on", i <= step));
}

function select(group: string, value: string) {
  document.querySelectorAll<HTMLElement>(`[data-${group}]`).forEach(choice => choice.classList.toggle("selected", choice.dataset[group] === value));
}

function renderChoices() {
  select("direction", settings.reverseVertical ? "reverse" : "normal");
  select("open", settings.activationMode);
  select("mode", settings.performanceMode);
  const keys = CHEAT_KEYS.filter(([action]) => settings.shortcuts[action].length).map(([action, label]): [string, string] => [comboLabel(settings.shortcuts[action][0]), label]);
  document.getElementById("cheat")!.innerHTML = [...CHEAT_SHEET, ...keys].map(([key, label]) => `<div><kbd>${escapeHtml(key)}</kbd><span class="muted">${escapeHtml(label)}</span></div>`).join("");
}

async function finish(openSettings: boolean) {
  settings = {...settings, onboardingComplete: true};
  await saveSettings(settings);
  if (openSettings) await chrome.runtime.openOptionsPage();
  else window.close();
}

progress.innerHTML = screens.map((_, i) => `<i class="${i === 0 ? "on" : ""}"></i>`).join("");
document.querySelectorAll(".next").forEach(button => button.addEventListener("click", () => show(step + 1)));

const demoLink = document.getElementById("demoLink")!, peek = document.getElementById("peek")!;
let demoClose: number | undefined;
const openDemo = () => {
  clearTimeout(demoClose);
  peek.classList.add("on");
};
const closeDemo = () => {
  demoClose = window.setTimeout(() => peek.classList.remove("on"), 500);
};
for (const el of [demoLink, peek]) {
  el.addEventListener("mouseenter", openDemo);
  el.addEventListener("mouseleave", closeDemo);
}

document.querySelectorAll<HTMLElement>("[data-direction]").forEach(choice => choice.addEventListener("click", () => {
  settings = {...settings, reverseVertical: choice.dataset.direction === "reverse"};
  renderChoices();
}));
document.querySelectorAll<HTMLElement>("[data-open]").forEach(choice => choice.addEventListener("click", () => {
  settings = {...settings, activationMode: choice.dataset.open as LinkPeekSettings["activationMode"]};
  renderChoices();
}));
document.querySelectorAll<HTMLElement>("[data-mode]").forEach(choice => choice.addEventListener("click", () => {
  settings = {...settings, performanceMode: choice.dataset.mode as LinkPeekSettings["performanceMode"]};
  renderChoices();
}));
document.getElementById("finish")!.addEventListener("click", () => void finish(false));
document.getElementById("settings")!.addEventListener("click", () => void finish(true));

void loadSettings().then(loaded => {
  settings = loaded;
  renderChoices();
});
