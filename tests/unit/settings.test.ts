import {describe,expect,it} from "vitest";
import {DEFAULT_SETTINGS,PRESETS,effectiveSettings} from "../../src/shared/settings";

describe("settings",()=>{
  it("ships touchpad-first defaults",()=>{
    expect(DEFAULT_SETTINGS.verticalGesture).toBe("navigate");
    expect(DEFAULT_SETTINGS.horizontalGesture).toBe("scrub");
    expect(DEFAULT_SETTINGS.pinchZoom).toBe(true);
    expect(DEFAULT_SETTINGS.scanScope).toBe("whole");
  });
  it("has the expected power-user presets",()=>expect(Object.keys(PRESETS)).toEqual(expect.arrayContaining(["balanced","minimal","fast","touchpad","manual"])));
  it("applies exact and wildcard site profiles",()=>{
    const settings={...DEFAULT_SETTINGS,siteProfiles:{"forum.example":{hoverDelay:50},"*.other.example":{enabled:false}}};
    expect(effectiveSettings(settings,"https://forum.example/t/x/1").hoverDelay).toBe(50);
    expect(effectiveSettings(settings,"https://sub.other.example/x").enabled).toBe(false);
  });
});
