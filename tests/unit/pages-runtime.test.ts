import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../../src/shared/settings";

const tick=async()=>{await Promise.resolve();await Promise.resolve()};

describe("page entrypoints",()=>{
  let store:Record<string,any>,changed:Function[],created:any[],openOptions:any;
  beforeEach(()=>{
    vi.resetModules();vi.useFakeTimers();document.body.innerHTML="";store={settings:{...DEFAULT_SETTINGS},favorites:[]};changed=[];created=[];
    openOptions=vi.fn();
    vi.stubGlobal("chrome",{
      storage:{local:{
        get:vi.fn(async(key:string)=>({[key]:store[key]})),
        set:vi.fn(async(v:any)=>{const before={...store};Object.assign(store,v);for(const cb of changed)cb(Object.fromEntries(Object.keys(v).map(k=>[k,{oldValue:before[k],newValue:v[k]}])))})
      },onChanged:{addListener:vi.fn((cb:Function)=>changed.push(cb))}},
      tabs:{query:vi.fn(async()=>[{url:"https://forum.test/t/a/1"}]),create:vi.fn(async(v:any)=>{created.push(v);return {id:1}})},
      runtime:{openOptionsPage:openOptions,getURL:vi.fn((p:string)=>`chrome-extension://id/${p}`),sendMessage:vi.fn(async()=>({ok:true}))}
    });
    (Element.prototype as any).scrollIntoView=vi.fn();
    vi.stubGlobal("location",{href:"https://extension.test/options.html",reload:vi.fn()});
  });
  afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML=""});

  it("runs onboarding interactions, directions, presets and completion actions",async()=>{
    document.body.innerHTML=`
      <div id="progress"></div>
      <section class="screen active"></section><section class="screen"></section><section class="screen"></section>
      <button class="next">next</button><a id="demoLink">demo</a><div id="peek"></div>
      <button data-direction="normal"></button><button data-direction="reverse"></button>
      <div id="presetChoices"></div><button id="finish"></button><button id="settings"></button>
    `;
    const close=vi.spyOn(window,"close").mockImplementation(()=>{});
    await import("../../src/pages/onboarding");await tick();
    expect(document.querySelectorAll("#progress i")).toHaveLength(3);
    (document.querySelector(".next") as HTMLButtonElement).click();
    expect(document.querySelectorAll(".screen")[1].classList.contains("active")).toBe(true);
    const demo=document.getElementById("demoLink")!;demo.dispatchEvent(new MouseEvent("mouseenter"));
    expect(document.getElementById("peek")!.classList.contains("on")).toBe(true);
    demo.dispatchEvent(new MouseEvent("mouseleave"));vi.advanceTimersByTime(500);expect(document.getElementById("peek")!.classList.contains("on")).toBe(false);
    (document.querySelector('[data-direction="reverse"]') as HTMLButtonElement).click();
    (document.querySelector('[data-direction="normal"]') as HTMLButtonElement).click();
    const presets=[...document.querySelectorAll<HTMLElement>("[data-preset]")];expect(presets.length).toBe(5);presets.forEach(x=>x.click());
    (document.getElementById("finish") as HTMLButtonElement).click();await tick();expect(store.settings.onboardingComplete).toBe(true);expect(close).toHaveBeenCalled();
    store.settings.onboardingComplete=false;(document.getElementById("settings") as HTMLButtonElement).click();await tick();expect(openOptions).toHaveBeenCalled();
  });

  it("renders and edits every options control family, resets, searches, presets and tutorial",async()=>{
    document.body.innerHTML='<input id="search"><div id="presets"></div><div id="nav"></div><div id="sections"></div><span id="saved"></span><button id="tutorial"></button>';
    await import("../../src/pages/options");await tick();
    expect(document.querySelectorAll(".section").length).toBeGreaterThan(10);
    const segmented=document.querySelector<HTMLElement>('[data-choice-key="prefetch"][data-choice-value="off"]')!;segmented.click();await tick();
    const checkbox=document.querySelector<HTMLInputElement>('input[data-key="enabled"]')!;checkbox.checked=false;checkbox.dispatchEvent(new Event("change"));await tick();
    const select=document.querySelector<HTMLSelectElement>('select[data-key="activationMode"]')!;select.value="click";select.dispatchEvent(new Event("change"));await tick();
    const range=document.querySelector<HTMLInputElement>('input[type="range"][data-key="panelOpacity"]')!;range.value=".5";range.dispatchEvent(new Event("change"));await tick();
    const number=document.querySelector<HTMLInputElement>('input[type="number"][data-key="hoverDelay"]')!;number.value="450";number.dispatchEvent(new Event("change"));await tick();
    document.querySelector<HTMLElement>('[data-step-key="hoverDelay"][data-step-dir="1"]')!.click();await tick();
    document.querySelector<HTMLElement>('[data-step-key="hoverDelay"][data-step-dir="-1"]')!.click();await tick();
    document.querySelector<HTMLElement>('[data-step-key="maxZoom"][data-step-dir="1"]')!.click();await tick();
    document.querySelector<HTMLElement>('[data-step-key="maxZoom"][data-step-dir="-1"]')!.click();await tick();
    const fallbackStep=document.querySelector<HTMLElement>('[data-step-key="minWidth"][data-step-dir="1"]')!;
    fallbackStep.removeAttribute("data-step-dir");fallbackStep.click();await tick();

    const zeroStep=document.querySelector<HTMLElement>('[data-step-key="maxZoom"][data-step-dir="1"]')!;zeroStep.dataset.stepDir="";zeroStep.click();await tick();
    const json=document.querySelector<HTMLTextAreaElement>('textarea[data-key="shortcuts"]')!;json.value="{";json.dispatchEvent(new Event("change"));expect(json.style.borderColor).not.toBe("");
    json.value='{"grid":["z"]}';json.dispatchEvent(new Event("change"));await tick();
    const text=document.querySelector<HTMLInputElement>('input[type="text"][data-key="customAccent"]')!;text.value="#fff";text.dispatchEvent(new Event("change"));await tick();
    document.querySelector<HTMLElement>('[data-reset="hoverDelay"]')!.click();await tick();
    document.querySelector<HTMLElement>('[data-reset-section="General"]')!.click();await tick();
    document.querySelector<HTMLElement>('[data-jump="Gallery"]')!.click();
    const search=document.getElementById("search") as HTMLInputElement;search.value="GIF";search.dispatchEvent(new Event("input"));expect(document.body.textContent).toContain("GIF");
    search.value="nothing-at-all";search.dispatchEvent(new Event("input"));expect(document.querySelectorAll(".section")).toHaveLength(0);
    search.value="";search.dispatchEvent(new Event("input"));
    const preset=document.querySelector<HTMLElement>("[data-preset]")!;preset.click();await tick();expect((location as any).reload).toHaveBeenCalled();
    (document.getElementById("tutorial") as HTMLButtonElement).click();expect((location as any).href).toContain("onboarding.html");
    vi.runAllTimers();
  });

  it("runs popup controls and offline favorite open/remove updates",async()=>{
    store.favorites=[{url:"https://fav.test/a",title:"<Saved & Link>",addedAt:2,mediaCount:4},{url:"https://fav.test/b",title:"No Count",addedAt:1}];
    document.body.innerHTML=`
      <input id="enabled" type="checkbox"><select id="preset"><option value="balanced">Balanced</option><option value="fast">Fast</option><option value="custom">Custom</option></select>
      <div id="site"></div><button id="disableSite"></button><button id="options"></button><button id="help"></button><button id="clear"></button>
      <span id="favoriteCount"></span><div id="favorites"></div>
    `;
    await import("../../src/pages/popup");await tick();
    expect(document.getElementById("site")!.textContent).toBe("forum.test");expect(document.getElementById("favoriteCount")!.textContent).toBe("2");
    const open=document.querySelector("[data-open-favorite]") as HTMLButtonElement;open.dataset.openFavorite="99";open.click();open.dataset.openFavorite="0";open.click();expect(created.some(x=>x.url==="https://fav.test/a")).toBe(true);
    const remove=document.querySelector("[data-remove-favorite]") as HTMLButtonElement;remove.dataset.removeFavorite="99";remove.click();await tick();remove.dataset.removeFavorite="0";remove.click();await tick();await tick();await tick();expect(store.favorites).toHaveLength(1);expect(document.getElementById("favoriteCount")!.textContent).toBe("1");
    const remaining=document.querySelector("[data-remove-favorite]") as HTMLButtonElement;remaining.click();await tick();await tick();expect(store.favorites).toHaveLength(0);expect(document.getElementById("favoriteCount")!.textContent).toBe("0");
    const enabled=document.getElementById("enabled") as HTMLInputElement;enabled.checked=false;enabled.dispatchEvent(new Event("change"));await tick();
    const preset=document.getElementById("preset") as HTMLSelectElement;preset.value="fast";preset.dispatchEvent(new Event("change"));await tick();
    preset.value="custom";preset.dispatchEvent(new Event("change"));await tick();
    (document.getElementById("options") as HTMLButtonElement).click();expect(openOptions).toHaveBeenCalled();
    (document.getElementById("help") as HTMLButtonElement).click();expect(created.some(x=>String(x.url).includes("onboarding"))).toBe(true);
    (document.getElementById("clear") as HTMLButtonElement).click();await tick();expect(document.getElementById("clear")!.textContent).toBe("Cleared");
    (document.getElementById("disableSite") as HTMLButtonElement).click();await tick();expect(store.settings.siteProfiles["forum.test"].enabled).toBe(false);
    (document.getElementById("disableSite") as HTMLButtonElement).click();await tick();expect(store.settings.siteProfiles["forum.test"].enabled).toBe(true);
    changed.forEach(cb=>cb({favorites:{newValue:[]}}));await tick();
  });

  it("covers popup non-web-page and empty-host site toggle guard",async()=>{
    (chrome.tabs.query as any).mockResolvedValueOnce([{url:"chrome://extensions"}]);
    document.body.innerHTML='<input id="enabled" type="checkbox"><select id="preset"><option value="balanced">Balanced</option></select><div id="site"></div><button id="disableSite"></button><button id="options"></button><button id="help"></button><button id="clear"></button><span id="favoriteCount"></span><div id="favorites"></div>';
    await import("../../src/pages/popup");await tick();expect(document.getElementById("site")!.textContent).toBe("Not a web page");
    (document.getElementById("disableSite") as HTMLButtonElement).click();await tick();
  });
});
