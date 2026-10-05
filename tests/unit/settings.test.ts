import {describe,expect,it} from "vitest";
import {DEFAULT_SETTINGS,PRESETS,effectiveSettings,migrateSettings} from "../../src/shared/settings";

describe("settings",()=>{
  it("ships touchpad-first defaults",()=>{
    expect(DEFAULT_SETTINGS.verticalGesture).toBe("navigate");
    expect(DEFAULT_SETTINGS.horizontalGesture).toBe("scrub");
    expect(DEFAULT_SETTINGS.pinchZoom).toBe(true);
    expect(DEFAULT_SETTINGS.scanScope).toBe("whole");
    expect(DEFAULT_SETTINGS.recursiveTrigger).toBe("empty");
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
});
