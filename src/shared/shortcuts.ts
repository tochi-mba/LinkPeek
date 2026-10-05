/**
 * Keyboard shortcuts are stored as combos such as "g", "Shift+n", "Ctrl+Alt+k",
 * "ArrowDown" or "Space". Letters are lower case and Shift is only written when
 * it changes the meaning (letters and named keys), so "?" stays "?" and Caps
 * Lock never turns "n" into a different shortcut.
 */
const MODIFIERS = ["Ctrl", "Alt", "Meta", "Shift"] as const;
const MODIFIER_KEYS = new Set(["Control", "Alt", "Meta", "Shift", "AltGraph", "CapsLock", "Fn", "OS"]);

function canonicalKey(key: string) {
  if (key === " " || key.toLowerCase() === "space" || key === "Spacebar") return "Space";
  if (key.toLowerCase() === "esc") return "Escape";
  return key.length === 1 ? key.toLowerCase() : key;
}

function shiftMatters(key: string) {
  return /^[a-z]$/.test(key) || key.length > 1;
}

/** Normalizes user or legacy input into the canonical combo form, or "" when unusable. */
export function normalizeCombo(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  const parts = text === "+" ? ["+"] : text.split("+").map(part => part.trim());
  if (text.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  // split() always creates at least one part, including for an empty string.
  const key = canonicalKey(parts.pop()!);
  if (!key || MODIFIER_KEYS.has(key)) return "";
  const held = new Set(parts.map(part => part.toLowerCase()));
  const mods = MODIFIERS.filter(mod => held.has(mod.toLowerCase()) || (mod === "Ctrl" && held.has("control")) || (mod === "Meta" && (held.has("cmd") || held.has("command"))));
  const effective = mods.filter(mod => mod !== "Shift" || shiftMatters(key));
  return [...effective, key].join("+");
}

/** The canonical combo for a key event, or "" for a lone modifier press. */
export function eventCombo(event: KeyboardEvent): string {
  if (MODIFIER_KEYS.has(event.key)) return "";
  const key = canonicalKey(event.key);
  const mods: string[] = [];
  if (event.ctrlKey) mods.push("Ctrl");
  if (event.altKey) mods.push("Alt");
  if (event.metaKey) mods.push("Meta");
  if (event.shiftKey && shiftMatters(key)) mods.push("Shift");
  return [...mods, key].join("+");
}

/** True when the event matches any of the combos. */
export function matchesCombo(event: KeyboardEvent, combos: readonly string[] | undefined) {
  if (!combos?.length) return false;
  const combo = eventCombo(event);
  return combo !== "" && combos.includes(combo);
}

const KEY_LABELS: Record<string, string> = {
  ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", Space: "Space", Enter: "Enter"
};

/** A short human label such as "Shift+N" or "↓". */
export function comboLabel(combo: string) {
  if (combo === "+") return "+";
  const parts = combo.split("+");
  if (combo.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const key = parts.pop()!;
  const label = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...parts, label].join("+");
}

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

function isTextEntry(node: EventTarget) {
  if (node instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(node.type);
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return true;
  if (!(node instanceof HTMLElement)) return false;
  const editable = node.getAttribute("contenteditable");
  return editable !== null && editable !== "false";
}

/** True when the key event comes from somewhere the person is typing. */
export function isTypingEvent(event: KeyboardEvent) {
  return event.composedPath().some(isTextEntry);
}
