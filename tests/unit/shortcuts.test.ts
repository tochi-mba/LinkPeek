import {describe, expect, it} from "vitest";
import {comboLabel, eventCombo, isTypingEvent, matchesCombo, normalizeCombo} from "../../src/shared/shortcuts";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", {bubbles: true, composed: true, ...init});

describe("shortcut combos", () => {
  it("normalize user and legacy input", () => {
    expect(normalizeCombo("N")).toBe("n");
    expect(normalizeCombo(" shift + N ")).toBe("Shift+n");
    expect(normalizeCombo("control+alt+cmd+shift+k")).toBe("Ctrl+Alt+Meta+Shift+k");
    expect(normalizeCombo("command+k")).toBe("Meta+k");
    expect(normalizeCombo("Shift+?")).toBe("?");
    expect(normalizeCombo("Shift+ArrowDown")).toBe("Shift+ArrowDown");
    expect(normalizeCombo("+")).toBe("+");
    expect(normalizeCombo("Ctrl++")).toBe("Ctrl++");
    expect(normalizeCombo("space")).toBe("Space");
    expect(normalizeCombo(" ")).toBe("");
    expect(normalizeCombo("esc")).toBe("Escape");
    expect(normalizeCombo("Shift")).toBe("");
    expect(normalizeCombo("")).toBe("");
  });

  it("read key events, ignoring Caps Lock and lone modifiers", () => {
    expect(eventCombo(key({key: "N"}))).toBe("n");
    expect(eventCombo(key({key: "N", shiftKey: true}))).toBe("Shift+n");
    expect(eventCombo(key({key: "?", shiftKey: true}))).toBe("?");
    expect(eventCombo(key({key: " "}))).toBe("Space");
    expect(eventCombo(key({key: "k", ctrlKey: true, altKey: true, metaKey: true}))).toBe("Ctrl+Alt+Meta+k");
    expect(eventCombo(key({key: "ArrowDown", shiftKey: true}))).toBe("Shift+ArrowDown");
    expect(eventCombo(key({key: "Shift", shiftKey: true}))).toBe("");
  });

  it("match only bound combos", () => {
    expect(matchesCombo(key({key: "g"}), ["g"])).toBe(true);
    expect(matchesCombo(key({key: "g", ctrlKey: true}), ["g"])).toBe(false);
    expect(matchesCombo(key({key: "g"}), [])).toBe(false);
    expect(matchesCombo(key({key: "g"}), undefined)).toBe(false);
    expect(matchesCombo(key({key: "Control", ctrlKey: true}), [""])).toBe(false);
  });

  it("have short readable labels", () => {
    expect(comboLabel("Shift+n")).toBe("Shift+N");
    expect(comboLabel("ArrowDown")).toBe("↓");
    expect(comboLabel("Escape")).toBe("Esc");
    expect(comboLabel("+")).toBe("+");
    expect(comboLabel("Ctrl++")).toBe("Ctrl++");
    expect(comboLabel("PageDown")).toBe("PageDown");
  });
});

describe("typing detection", () => {
  it("treats text fields and editable regions as typing, but not sliders or buttons", () => {
    const fire = (el: Element) => {
      document.body.append(el);
      const event = key({key: "n"});
      let typing = false;
      el.addEventListener("keydown", e => typing = isTypingEvent(e as KeyboardEvent));
      el.dispatchEvent(event);
      el.remove();
      return typing;
    };
    expect(fire(Object.assign(document.createElement("input"), {type: "text"}))).toBe(true);
    expect(fire(Object.assign(document.createElement("input"), {type: "range"}))).toBe(false);
    expect(fire(document.createElement("textarea"))).toBe(true);
    expect(fire(document.createElement("select"))).toBe(true);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "");
    const child = document.createElement("span");
    editable.append(child);
    document.body.append(editable);
    let typing = false;
    child.addEventListener("keydown", e => typing = isTypingEvent(e as KeyboardEvent));
    child.dispatchEvent(key({key: "n"}));
    expect(typing).toBe(true);
    editable.setAttribute("contenteditable", "false");
    child.dispatchEvent(key({key: "n"}));
    expect(typing).toBe(false);
    editable.remove();
    expect(fire(document.createElement("button"))).toBe(false);
    let documentTyping = true;
    document.addEventListener("keydown", e => documentTyping = isTypingEvent(e), {once: true});
    document.dispatchEvent(key({key: "n"}));
    expect(documentTyping).toBe(false);
  });
});
