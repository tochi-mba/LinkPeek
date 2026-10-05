import {describe, expect, it} from "vitest";
import {INTERNAL_SETTINGS, SECTIONS, SHORTCUT_LABELS, fieldFor} from "../../src/pages/settings-schema";
import {DEFAULT_SETTINGS, SETTING_CHOICES, SETTING_RANGES, SHORTCUT_ACTIONS} from "../../src/shared/settings";

const fields = SECTIONS.flatMap(section => section.fields);

describe("the settings page schema", () => {
  it("shows every setting exactly once, and nothing that is not a setting", () => {
    const shown = fields.map(field => field.key);
    expect(new Set(shown).size).toBe(shown.length);
    expect([...shown, ...INTERNAL_SETTINGS].sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it("gives every number a range and every choice a label for each allowed value", () => {
    for (const field of fields) {
      const value = DEFAULT_SETTINGS[field.key];
      if (typeof value === "number") expect(SETTING_RANGES[field.key], field.key).toBeDefined();
      if (field.options) expect(Object.keys(field.options).sort(), field.key).toEqual([...(SETTING_CHOICES[field.key] ?? [])].sort());
      if (typeof value === "string" && !field.options) throw new Error(`${field.key} needs labelled options`);
    }
  });

  it("writes help for every field and keeps essentials free of advanced detail", () => {
    for (const field of fields) expect(field.help.length, field.key).toBeGreaterThan(10);
    expect(SECTIONS[0].fields.every(field => !field.advanced)).toBe(true);
  });

  it("labels every shortcut action", () => {
    expect(Object.keys(SHORTCUT_LABELS).sort()).toEqual([...SHORTCUT_ACTIONS].sort());
  });

  it("finds a field by its key", () => {
    expect(fieldFor("hoverDelay")!.label).toBe("Hover delay");
    expect(fieldFor("onboardingComplete")).toBeUndefined();
  });
});
