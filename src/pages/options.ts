/**
 * The settings page, rendered from SECTIONS. Every change saves immediately;
 * only values that differ from the defaults are stored.
 */
import {escapeHtml} from "../shared/dom";
import {
  DEFAULT_SETTINGS, SETTING_CHOICES, SETTING_RANGES, SETTINGS_VERSION, SHORTCUT_ACTIONS, loadSettings, normalizeKeywords,
  resolveSettings, saveSettings, settingsOverrides, type LinkPeekSettings, type ShortcutAction, type SiteProfiles
} from "../shared/settings";
import {SEEN_KEYS, forgetSeenMedia} from "../shared/seen-media";
import {comboLabel, eventCombo} from "../shared/shortcuts";
import {SECTIONS, SHORTCUT_LABELS, fieldFor, type Control, type FieldSpec, type SectionSpec, type SettingKey} from "./settings-schema";

const ADVANCED_KEY = "linkpeek-show-advanced";
const MAX_KEYS_PER_ACTION = 4;

let state: LinkPeekSettings = DEFAULT_SETTINGS;
let query = "";
let showAdvanced = false;
let recording: ShortcutAction | null = null;
let savedTimer: number | undefined;
/** Media remembered as seen, shown on the button that forgets them. */
let seenCount = 0;
/** Galleries saved on the device, shown on the button that forgets them. */
let galleryStats = {count: 0, bytes: 0};
/** Media saved on the device, shown beside the setting with a button to delete it. */
let libraryStats = {count: 0, bytes: 0};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isDefault(key: SettingKey) {
  return same(state[key], DEFAULT_SETTINGS[key]);
}

function readAdvancedPreference() {
  try {
    return localStorage.getItem(ADVANCED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeAdvancedPreference(value: boolean) {
  try {
    localStorage.setItem(ADVANCED_KEY, value ? "1" : "0");
  } catch {
    // Private windows can refuse storage; the toggle still works for this visit.
  }
}

function controlFor(field: FieldSpec): Control {
  if (field.control) return field.control;
  const value = DEFAULT_SETTINGS[field.key];
  // String settings always declare a labelled choice control; the schema test
  // enforces that invariant, leaving only booleans and numbers to infer here.
  return typeof value === "boolean" ? "toggle" : "number";
}

function choicesFor(field: FieldSpec) {
  // Choice fields are schema-checked to label every allowed value.
  return SETTING_CHOICES[field.key]!.map(value => [value, field.options![value]] as const);
}

function formatNumber(_field: FieldSpec, value: number) {
  // Every slider is a 0–1 percentage; ordinary numeric settings use a number input.
  return `${Math.round(value * 100)}%`;
}

function toggleMarkup(field: FieldSpec) {
  const id = `field-${field.key}`;
  return `<label class="switch"><input id="${id}" type="checkbox" data-key="${field.key}" ${state[field.key] ? "checked" : ""}><span class="switch-track"><span class="switch-thumb"></span></span></label>`;
}

function segmentedMarkup(field: FieldSpec) {
  const value = state[field.key];
  return `<div class="segmented" role="radiogroup" aria-label="${escapeHtml(field.label)}">${choicesFor(field).map(([option, label]) =>
    `<button type="button" role="radio" class="segment${option === value ? " active" : ""}" aria-checked="${option === value}" data-choice-key="${field.key}" data-choice-value="${option}">${escapeHtml(label)}</button>`).join("")}</div>`;
}

function selectMarkup(field: FieldSpec) {
  const value = state[field.key];
  return `<span class="select-shell"><select id="field-${field.key}" data-key="${field.key}">${choicesFor(field).map(([option, label]) =>
    `<option value="${option}" ${option === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select><span class="select-chevron">⌄</span></span>`;
}

function numberMarkup(field: FieldSpec) {
  const range = SETTING_RANGES[field.key]!, value = state[field.key] as number;
  return `<div class="number-shell"><button type="button" class="number-step" data-step-key="${field.key}" data-step-dir="-1" aria-label="Decrease ${escapeHtml(field.label)}">−</button>`
    + `<input id="field-${field.key}" type="number" value="${value}" min="${range.min}" max="${range.max}" step="${range.step}" data-key="${field.key}">`
    + `<button type="button" class="number-step" data-step-key="${field.key}" data-step-dir="1" aria-label="Increase ${escapeHtml(field.label)}">+</button>`
    + `${field.unit ? `<span class="number-unit">${escapeHtml(field.unit)}</span>` : ""}</div>`;
}

function rangeMarkup(field: FieldSpec) {
  const range = SETTING_RANGES[field.key]!, value = state[field.key] as number;
  return `<div class="range-control"><input id="field-${field.key}" type="range" min="${range.min}" max="${range.max}" step="${range.step}" value="${value}" data-key="${field.key}"><span class="value-num">${formatNumber(field, value)}</span></div>`;
}

function keywordsMarkup(field: FieldSpec) {
  return `<textarea id="field-${field.key}" class="text-area" rows="3" data-key="${field.key}" data-format="keywords" placeholder="gallery, photos, /media/">${escapeHtml(state.activationKeywords.join("\n"))}</textarea>`;
}

function shortcutsMarkup() {
  return `<div class="shortcuts">${SHORTCUT_ACTIONS.map(action => {
    const keys = state.shortcuts[action], label = SHORTCUT_LABELS[action];
    const chips = keys.map(combo => `<span class="chip"><kbd>${escapeHtml(comboLabel(combo))}</kbd><button type="button" data-remove-key="${action}" data-combo="${escapeHtml(combo)}" aria-label="Remove ${escapeHtml(comboLabel(combo))} from ${escapeHtml(label)}">×</button></span>`).join("");
    const add = recording === action
      ? `<span class="chip recording" role="status">Press keys… <button type="button" data-cancel-record>Cancel</button></span>`
      : keys.length < MAX_KEYS_PER_ACTION ? `<button type="button" class="chip-add" data-record="${action}" aria-label="Add a key for ${escapeHtml(label)}">+</button>` : "";
    const reset = same(keys, DEFAULT_SETTINGS.shortcuts[action]) ? "" : `<button type="button" class="reset" data-reset-shortcut="${action}" title="Reset to default">↺</button>`;
    return `<div class="shortcut-row"><span class="shortcut-label">${escapeHtml(label)}</span><span class="chips">${chips || '<span class="muted">No key</span>'}${add}${reset}</span></div>`;
  }).join("")}</div>`;
}

function seenMarkup() {
  const label = seenCount ? `Forget what I have seen (${seenCount.toLocaleString()})` : "Nothing remembered yet";
  return `<button type="button" class="button ghost" data-forget-seen${seenCount ? "" : " disabled"}>${label}</button>`;
}

function sizeLabel(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function galleriesMarkup() {
  const {count, bytes} = galleryStats;
  const label = count ? `Forget saved galleries (${count.toLocaleString()} · ${sizeLabel(bytes)})` : "No galleries saved yet";
  return `<button type="button" class="button ghost" data-forget-galleries${count ? "" : " disabled"}>${label}</button>`;
}

function libraryMarkup() {
  const {count, bytes} = libraryStats;
  const label = count ? `Delete saved media (${count.toLocaleString()} · ${sizeLabel(bytes)})` : "Nothing saved yet";
  return `<button type="button" class="button ghost" data-clear-library${count ? "" : " disabled"}>${label}</button>`;
}

/** Counts from the service worker: {count, bytes}, or zeros when it does not answer. */
async function loadStats(type: "LINKPEEK_GALLERY_STATS" | "LINKPEEK_LIBRARY_STATS") {
  const stats = await chrome.runtime.sendMessage({type}) as {count?: number; bytes?: number} | undefined;
  return {count: stats?.count ?? 0, bytes: stats?.bytes ?? 0};
}

async function countSeen() {
  const stored = await chrome.storage.local.get(SEEN_KEYS);
  return SEEN_KEYS.reduce((total, key) => total + (Array.isArray(stored[key]) ? (stored[key] as unknown[]).length : 0), 0);
}

function describeRule(rule: Partial<LinkPeekSettings>) {
  if (rule.enabled === false) return "LinkPeek is paused here";
  const count = Object.keys(rule).filter(key => key !== "enabled").length;
  return count ? `${count} custom setting${count === 1 ? "" : "s"}` : "No changes";
}

function sitesMarkup() {
  const entries = Object.entries(state.siteProfiles);
  const list = entries.length
    ? entries.map(([host, rule]) => `<li class="site-row"><span><strong>${escapeHtml(host)}</strong><small>${describeRule(rule)}</small></span>`
      + `<button type="button" class="button ghost" data-site-toggle="${escapeHtml(host)}">${rule.enabled === false ? "Resume" : "Pause"}</button>`
      + `<button type="button" class="button ghost" data-site-remove="${escapeHtml(host)}" aria-label="Remove the rule for ${escapeHtml(host)}">Remove</button></li>`).join("")
    : `<li class="site-empty muted">No site rules yet. Pause a site here or from the toolbar button while you are on it.</li>`;
  const json = showAdvanced
    ? `<details class="site-json"><summary>Edit rules as JSON</summary><textarea class="text-area code" rows="6" data-sites-json>${escapeHtml(JSON.stringify(state.siteProfiles, null, 2))}</textarea><small>Any setting can be changed per site, for example {"forum.example.com": {"hoverDelay": 150}}.</small></details>`
    : "";
  return `<div class="sites"><form class="site-add" data-site-form><input name="host" aria-label="Website" placeholder="example.com or *.example.com" autocomplete="off"><button type="submit" class="button">Pause LinkPeek there</button></form><ul class="site-list">${list}</ul>${json}</div>`;
}

function controlMarkup(field: FieldSpec) {
  switch (controlFor(field)) {
    case "toggle": return toggleMarkup(field);
    case "segmented": return segmentedMarkup(field);
    case "number": return numberMarkup(field);
    case "range": return rangeMarkup(field);
    case "keywords": return keywordsMarkup(field);
    case "shortcuts": return shortcutsMarkup();
    case "sites": return sitesMarkup();
    case "seen": return toggleMarkup(field) + seenMarkup();
    case "galleries": return toggleMarkup(field) + galleriesMarkup();
    case "library": return toggleMarkup(field) + libraryMarkup();
    default: return selectMarkup(field);
  }
}

function matches(section: SectionSpec, field: FieldSpec) {
  if (!query) return !field.advanced || showAdvanced;
  const text = `${section.title} ${field.label} ${field.help} ${field.key}`.toLowerCase();
  return query.split(/\s+/).every(word => text.includes(word));
}

function fieldMarkup(field: FieldSpec) {
  const control = controlFor(field), wide = control === "shortcuts" || control === "sites" || control === "keywords";
  const reset = control === "shortcuts" || control === "sites" ? "" : `<button type="button" class="reset" data-reset="${field.key}" title="Reset to default" ${isDefault(field.key) ? "hidden" : ""}>↺</button>`;
  return `<div class="field${wide ? " wide" : ""}" data-field="${field.key}"><div class="field-text"><label for="field-${field.key}"><strong>${escapeHtml(field.label)}</strong></label>`
    + `${field.advanced ? '<span class="tag">Advanced</span>' : ""}<small>${escapeHtml(field.help)}</small></div>`
    + `<div class="field-control">${controlMarkup(field)}${reset}</div></div>`;
}

function render() {
  const visible = SECTIONS.map(section => ({section, fields: section.fields.filter(field => matches(section, field))})).filter(entry => entry.fields.length);
  $("nav").innerHTML = visible.map(({section}) => `<a href="#section-${section.id}">${escapeHtml(section.title)}</a>`).join("");
  $("sections").innerHTML = visible.length ? visible.map(({section, fields}) => {
    const modified = section.fields.some(field => !isDefault(field.key));
    return `<section class="section card" id="section-${section.id}" data-section="${section.id}"><header class="section-head"><div><h2>${escapeHtml(section.title)}${modified ? '<span class="modified" title="Changed from the defaults"></span>' : ""}</h2><p class="muted">${escapeHtml(section.summary)}</p></div>`
      + `${modified ? `<button type="button" class="reset section-reset" data-reset-section="${section.id}">Reset section ↺</button>` : ""}</header>`
      + `<div class="section-body">${fields.map(fieldMarkup).join("")}</div></section>`;
  }).join("") : `<p class="muted empty-search">No setting matches “${escapeHtml(query)}”.</p>`;
  ($("advanced") as HTMLInputElement).checked = showAdvanced;
}

/** Re-renders while keeping the scroll position, so a change never jumps the page. */
function rerender() {
  const scroll = scrollY;
  render();
  scrollTo(0, scroll);
}

/** Shows a short note by the title; longer notes (usually problems) stay long enough to read. */
function flashSaved(text = "Saved") {
  const saved = $("saved");
  saved.textContent = text;
  clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => saved.textContent = "", Math.max(1200, text.length * 60));
}

async function persist(text?: string) {
  await saveSettings(state);
  flashSaved(text);
}

async function update<K extends SettingKey>(key: K, value: LinkPeekSettings[K], rerenderAfter = false) {
  state = resolveSettings({...settingsOverrides(state), [key]: value});
  await persist();
  if (rerenderAfter) rerender();
  else document.querySelector(`[data-reset="${key}"]`)?.toggleAttribute("hidden", isDefault(key));
}

function readControl(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
  if (el instanceof HTMLInputElement && el.type === "checkbox") return el.checked;
  if (el instanceof HTMLInputElement && (el.type === "number" || el.type === "range")) return Number(el.value);
  if (el.dataset.format === "keywords") return normalizeKeywords(el.value.split(/[\n,]+/));
  return el.value;
}

function normalizeHost(raw: string) {
  const text = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "");
  return /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(text) ? text : "";
}

async function setSites(sites: SiteProfiles) {
  await update("siteProfiles", sites, true);
}

async function onClick(event: MouseEvent) {
  const target = (event.target as Element).closest<HTMLElement>("button");
  if (!target) return;
  const data = target.dataset;
  if (data.choiceKey) return update(data.choiceKey as SettingKey, data.choiceValue as never, true);
  if (data.stepKey) {
    const key = data.stepKey as SettingKey, range = SETTING_RANGES[key]!, current = state[key] as number;
    const next = Math.round(Math.min(range.max, Math.max(range.min, current + Number(data.stepDir) * range.step)) * 1000) / 1000;
    const input = document.querySelector<HTMLInputElement>(`input[data-key="${key}"]`)!;
    input.value = String(next);
    return update(key, next as never);
  }
  if (data.clearLibrary !== undefined) {
    await chrome.runtime.sendMessage({type: "LINKPEEK_LIBRARY_CLEAR"});
    libraryStats = {count: 0, bytes: 0};
    flashSaved("Deleted all saved media");
    return rerender();
  }
  if (data.forgetGalleries !== undefined) {
    await chrome.runtime.sendMessage({type: "LINKPEEK_FORGET_GALLERIES"});
    galleryStats = {count: 0, bytes: 0};
    flashSaved("Forgot every saved gallery");
    return rerender();
  }
  if (data.forgetSeen !== undefined) {
    await forgetSeenMedia();
    seenCount = 0;
    flashSaved("Forgot everything you have seen");
    return rerender();
  }
  if (data.reset) return update(data.reset as SettingKey, DEFAULT_SETTINGS[data.reset as SettingKey] as never, true);
  if (data.resetSection) {
    const section = SECTIONS.find(entry => entry.id === data.resetSection)!;
    const overrides = settingsOverrides(state) as Record<string, unknown>;
    for (const field of section.fields) delete overrides[field.key];
    state = resolveSettings(overrides);
    await persist("Section reset");
    return rerender();
  }
  if (data.record) {
    recording = data.record as ShortcutAction;
    return rerender();
  }
  if (data.cancelRecord !== undefined) {
    recording = null;
    return rerender();
  }
  if (data.removeKey) {
    const action = data.removeKey as ShortcutAction;
    return update("shortcuts", {...state.shortcuts, [action]: state.shortcuts[action].filter(combo => combo !== data.combo)}, true);
  }
  if (data.resetShortcut) {
    const action = data.resetShortcut as ShortcutAction;
    return update("shortcuts", {...state.shortcuts, [action]: DEFAULT_SETTINGS.shortcuts[action]}, true);
  }
  if (data.siteToggle) {
    const rule = state.siteProfiles[data.siteToggle];
    return setSites({...state.siteProfiles, [data.siteToggle]: {...rule, enabled: rule.enabled === false}});
  }
  if (data.siteRemove) {
    const sites = {...state.siteProfiles};
    delete sites[data.siteRemove];
    return setSites(sites);
  }
}

async function onChange(event: Event) {
  const el = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (el.matches("[data-sites-json]")) {
    try {
      await setSites(JSON.parse(el.value));
    } catch {
      el.classList.add("invalid");
      flashSaved("That JSON is not valid");
    }
    return;
  }
  const key = el.dataset.key as SettingKey | undefined;
  if (!key) return;
  const value = readControl(el);
  await update(key, value as never, el.dataset.format === "keywords" || el.type === "number");
}

function onInput(event: Event) {
  const el = event.target as HTMLInputElement;
  if (el.type !== "range") return;
  el.parentElement!.querySelector(".value-num")!.textContent = formatNumber(fieldFor(el.dataset.key as SettingKey)!, Number(el.value));
}

async function onSubmit(event: SubmitEvent) {
  const form = event.target as HTMLFormElement;
  if (!form.matches("[data-site-form]")) return;
  event.preventDefault();
  const input = form.elements.namedItem("host") as HTMLInputElement, host = normalizeHost(input.value);
  if (!host) {
    input.classList.add("invalid");
    flashSaved("Enter a site like example.com");
    return;
  }
  await setSites({...state.siteProfiles, [host]: {...state.siteProfiles[host], enabled: false}});
}

/** While recording, the next key press becomes a shortcut; it moves from any action that already had it. */
async function onKeyDown(event: KeyboardEvent) {
  if (!recording) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    recording = null;
    return rerender();
  }
  const combo = eventCombo(event);
  if (!combo) return;
  const action = recording, shortcuts = {...state.shortcuts}, previous = SHORTCUT_ACTIONS.find(other => other !== action && shortcuts[other].includes(combo));
  if (previous) shortcuts[previous] = shortcuts[previous].filter(existing => existing !== combo);
  shortcuts[action] = [...new Set([...shortcuts[action], combo])];
  recording = null;
  state = resolveSettings({...settingsOverrides(state), shortcuts});
  await persist(previous ? `Moved ${comboLabel(combo)} from “${SHORTCUT_LABELS[previous]}”` : "Saved");
  rerender();
}

function exportSettings() {
  const blob = new Blob([JSON.stringify({linkpeek: SETTINGS_VERSION, settings: settingsOverrides(state)}, null, 2)], {type: "application/json"});
  const link = Object.assign(document.createElement("a"), {href: URL.createObjectURL(blob), download: "linkpeek-settings.json"});
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importSettings(file: File) {
  try {
    const parsed = JSON.parse(await file.text()) as {settings?: unknown};
    state = resolveSettings(parsed && typeof parsed === "object" && "settings" in parsed ? parsed.settings : parsed);
    await persist("Settings imported");
    rerender();
  } catch {
    flashSaved("That file is not a LinkPeek settings file");
  }
}

async function resetEverything() {
  if (!confirm("Reset every LinkPeek setting to its default? Saved links are kept.")) return;
  state = resolveSettings({onboardingComplete: state.onboardingComplete});
  await persist("Everything reset");
  rerender();
}

async function start() {
  showAdvanced = readAdvancedPreference();
  const none = {count: 0, bytes: 0};
  [state, seenCount, galleryStats, libraryStats] = await Promise.all([
    loadSettings(), countSeen().catch(() => 0), loadStats("LINKPEEK_GALLERY_STATS").catch(() => none), loadStats("LINKPEEK_LIBRARY_STATS").catch(() => none)
  ]);
  render();
  const sections = $("sections");
  sections.addEventListener("click", event => void onClick(event));
  sections.addEventListener("change", event => void onChange(event));
  sections.addEventListener("input", onInput);
  sections.addEventListener("submit", event => void onSubmit(event as SubmitEvent));
  document.addEventListener("keydown", event => void onKeyDown(event), true);
  $("search").addEventListener("input", event => {
    query = (event.target as HTMLInputElement).value.trim().toLowerCase();
    render();
  });
  $("advanced").addEventListener("change", event => {
    showAdvanced = (event.target as HTMLInputElement).checked;
    writeAdvancedPreference(showAdvanced);
    rerender();
  });
  $("tutorial").addEventListener("click", () => location.href = chrome.runtime.getURL("onboarding.html"));
  $("export").addEventListener("click", exportSettings);
  $("import").addEventListener("change", event => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void importSettings(file);
  });
  $("resetAll").addEventListener("click", () => void resetEverything());
  // Changes made in the popup or another settings tab show up here too.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    const fresh = resolveSettings(changes.settings.newValue);
    if (same(fresh, state)) return;
    state = fresh;
    rerender();
  });
}

void start();
