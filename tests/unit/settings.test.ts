import {describe,expect,it} from "vitest";
import {DEFAULT_SETTINGS,PRESETS,effectiveSettings,linkMatchesKeywords,migrateSettings} from "../../src/shared/settings";

describe("settings",()=>{
  it("ships touchpad-first defaults",()=>{
    expect(DEFAULT_SETTINGS.verticalGesture).toBe("navigate");
    expect(DEFAULT_SETTINGS.horizontalGesture).toBe("scrub");
    expect(DEFAULT_SETTINGS.pinchZoom).toBe(true);
    expect(DEFAULT_SETTINGS.scanScope).toBe("whole");
    expect(DEFAULT_SETTINGS.recursiveTrigger).toBe("empty");
    expect(DEFAULT_SETTINGS.activationKeywords).toEqual([]);
  });
  it("has the expected power-user presets",()=>expect(Object.keys(PRESETS)).toEqual(expect.arrayContaining(["balanced","minimal","fast","touchpad","manual"])));
  it("migrates legacy resource defaults without changing customized values",()=>{
    const legacy={maxRequests:3,maxCacheMb:250,preloadNext:4,preloadPrevious:2,preloadConcurrency:4,preloadMemoryMb:192,preloadRest:"idle" as const,preloadRestLimit:120,preloadOriginals:"next" as const};
    expect(migrateSettings(legacy)).toMatchObject({maxCacheMb:64,preloadMemoryMb:64,preloadRest:"off",preloadOriginals:"never"});
    expect(migrateSettings({...legacy,maxCacheMb:99}).maxCacheMb).toBe(99);
  });
  it("applies exact and wildcard site profiles",()=>{
    const settings={...DEFAULT_SETTINGS,siteProfiles:{"forum.example":{hoverDelay:50},"*.other.example":{enabled:false}}};
    expect(effectiveSettings(settings,"https://forum.example/t/x/1").hoverDelay).toBe(50);
    expect(effectiveSettings(settings,"https://sub.other.example/x").enabled).toBe(false);
  });
  it("matches optional destination keywords case-insensitively and safely",()=>{
    expect(linkMatchesKeywords(DEFAULT_SETTINGS,"https://example.test/anything")).toBe(true);
    const filtered={activationKeywords:[" Gallery ","photo album",""]};
    expect(linkMatchesKeywords(filtered,"https://example.test/GALLERY/12")).toBe(true);
    expect(linkMatchesKeywords(filtered,"https://example.test/photo%20album/12")).toBe(true);
    expect(linkMatchesKeywords(filtered,"https://example.test/topic/12")).toBe(false);
    expect(linkMatchesKeywords(filtered,"https://example.test/%E0%A4%A")).toBe(false);
    expect(linkMatchesKeywords({activationKeywords:null as unknown as string[]},"https://example.test/x")).toBe(true);
  });
});
