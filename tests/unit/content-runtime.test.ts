import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../../src/shared/settings";
import type {ScanResult} from "../../src/shared/media";

const vm=vi.hoisted(()=>({instances:[] as any[]}));
const settingsHarness=vi.hoisted(()=>({current:null as any}));
vi.mock("../../src/shared/settings",async(importOriginal)=>{
  const actual=await importOriginal<any>();
  return {...actual,loadSettings:vi.fn(async()=>settingsHarness.current??actual.DEFAULT_SETTINGS)};
});
vi.mock("../../src/ui/viewer",()=>({
  Viewer:class{
    host=document.createElement("div");pinned=false;closeTimer:any;
    restoreViewerState=vi.fn();key=vi.fn(()=>false);show=vi.fn();openLoading=vi.fn();close=vi.fn();error=vi.fn();
    constructor(){vm.instances.push(this)}
  }
}));

const scan=(url:string):ScanResult=>({url,kind:"generic",title:"x",items:[],complete:true,diagnostics:{adapter:"x",ignored:0,duplicates:0,warnings:[]}});

describe("content script runtime",()=>{
  let store:any,changed:Function[],runtimeListeners:Function[],messages:any[],idleCb:Function|undefined,viewer:any;
  let sendImpl:(msg:any)=>Promise<any>;
  const tick=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve()};

  beforeEach(async()=>{
    vi.resetModules();vi.useFakeTimers();vm.instances.length=0;document.body.innerHTML="";
    store={settings:{...DEFAULT_SETTINGS,hoverDelay:20,closeDelay:10,prefetch:"nearby"},viewerState:{view:"grid",gridThumbSize:90,expanded:false}};
    settingsHarness.current=store.settings;
    changed=[];runtimeListeners=[];messages=[];idleCb=undefined;
    sendImpl=async(msg:any)=>{if(msg.type==="LINKPEEK_SCAN")return scan(msg.url);return {ok:true}};
    vi.stubGlobal("chrome",{
      storage:{
        local:{get:vi.fn(async(k:string)=>({[k]:store[k]})),set:vi.fn(async(v:any)=>Object.assign(store,v))},
        onChanged:{addListener:vi.fn((cb:Function)=>changed.push(cb))}
      },
      runtime:{
        onMessage:{addListener:vi.fn((cb:Function)=>runtimeListeners.push(cb))},
        sendMessage:vi.fn(async(msg:any)=>{messages.push(msg);return sendImpl(msg)})
      }
    });
    vi.stubGlobal("requestIdleCallback",vi.fn((cb:Function)=>{idleCb=cb;return 1}));
    await import("../../src/content");await tick();viewer=vm.instances.at(-1);
  });
  afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML=""});

  const update=async(patch:any)=>{store.settings={...store.settings,...patch};settingsHarness.current=store.settings;for(const cb of changed)await cb({settings:{newValue:store.settings}});await tick()};
  const link=(id:string,href:string,rect:any={left:10,top:10,right:110,bottom:30})=>{
    const a=document.createElement("a");a.id=id;a.href=href;a.textContent=id;(a as any).getBoundingClientRect=()=>rect;document.body.appendChild(a);return a;
  };
  const pointer=(type:string,target:Element,x=20,y=20,extra:MouseEventInit={})=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,...extra}));

  it("boots/restores state and activates hover previews",async()=>{
    expect(viewer.restoreViewerState).toHaveBeenCalledWith(store.viewerState);
    const a=link("a","https://x.test/page");
    pointer("pointerover",a);vi.advanceTimersByTime(21);await tick();
    expect(viewer.openLoading).toHaveBeenCalled();expect(viewer.show).toHaveBeenCalled();
    expect(messages.some(x=>x.type==="LINKPEEK_SCAN")).toBe(true);
    const key=new KeyboardEvent("keydown",{key:"g",bubbles:true,cancelable:true});viewer.key.mockReturnValueOnce(true);document.dispatchEvent(key);expect(key.defaultPrevented).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown",{key:"x",bubbles:true,cancelable:true}));
  });

  it("re-arms hover after pointer movement without requiring leave/re-enter",async()=>{
    const a=link("moving","https://x.test/moving");
    pointer("pointerover",a,10,10);pointer("pointermove",a,200,200);
    expect(messages.filter(x=>x.type==="LINKPEEK_SCAN")).toHaveLength(0);
    pointer("pointermove",a,205,205);vi.advanceTimersByTime(260);await tick();
    expect(messages.some(x=>x.type==="LINKPEEK_SCAN"&&x.url.includes("moving"))).toBe(true);
    pointer("pointerover",a,205,205);vi.advanceTimersByTime(30);await tick();
  });

  it("ignores child transitions and the viewer bridge, then closes on a real leave",async()=>{
    const a=link("parent","https://x.test/parent"),child=document.createElement("span");a.appendChild(child);
    pointer("pointerover",child);vi.advanceTimersByTime(21);await tick();
    pointer("pointerout",child,20,20,{relatedTarget:a});expect(viewer.close).not.toHaveBeenCalled();
    a.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:viewer.host}));expect(viewer.close).not.toHaveBeenCalled();
    a.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:document.body}));vi.advanceTimersByTime(11);expect(viewer.close).toHaveBeenCalled();
  });

  it("supports modifier hover and click activation modes",async()=>{
    const a=link("mod","https://x.test/mod");
    await update({activationMode:"modifier"});
    pointer("pointerover",a);vi.advanceTimersByTime(30);await tick();expect(messages.some(x=>x.type==="LINKPEEK_SCAN"&&x.url?.includes("mod"))).toBe(false);
    pointer("pointermove",a,20,20,{altKey:true});vi.advanceTimersByTime(25);await tick();expect(messages.some(x=>x.type==="LINKPEEK_SCAN"&&x.url?.includes("mod"))).toBe(true);
    pointer("pointermove",a,21,21,{altKey:false});
    await update({activationMode:"click"});
    const b=link("click","https://x.test/click");const ev=new MouseEvent("click",{bubbles:true,cancelable:true,clientX:30,clientY:30});b.dispatchEvent(ev);await tick();
    expect(ev.defaultPrevented).toBe(true);expect(messages.some(x=>x.url?.includes("click"))).toBe(true);
    document.body.dispatchEvent(new MouseEvent("click",{bubbles:true}));
  });

  it("filters unsupported hover links and disabled site settings",async()=>{
    for(const [name,url] of [["anchor","#x"],["download","https://x.test/a.zip"],["ignored","mailto:a@b.test"]] as const){
      const a=link(name,url);pointer("pointerover",a);vi.advanceTimersByTime(30);await tick();
    }
    const before=messages.filter(x=>x.type==="LINKPEEK_SCAN").length;await update({enabled:false});const x=link("disabled","https://x.test/disabled");pointer("pointerover",x);vi.advanceTimersByTime(30);await tick();expect(messages.filter(x=>x.type==="LINKPEEK_SCAN").length).toBe(before);
  });

  it("handles progressive messages, cancelled/error/throwing scans and stale responses",async()=>{
    let resolve!:Function;
    sendImpl=async(msg:any)=>{
      if(msg.type!=="LINKPEEK_SCAN")return {ok:true};
      if(msg.url.includes("cancel"))return {cancelled:true};
      if(msg.url.includes("error"))return {error:"bad"};
      if(msg.url.includes("stringthrow"))throw "oops";
      if(msg.url.includes("throw"))throw new Error("boom");
      if(msg.url.includes("slow"))return await new Promise(r=>{resolve=r});
      return scan(msg.url);
    };
    for(const name of ["cancel","error","throw","stringthrow"]){
      const a=link(name,`https://x.test/${name}`);pointer("pointerover",a);vi.advanceTimersByTime(21);await tick();
    }
    expect(viewer.error).toHaveBeenCalledWith("bad");expect(viewer.error).toHaveBeenCalledWith("boom");expect(viewer.error).toHaveBeenCalledWith("oops");
    const slow=link("slow","https://x.test/slow");pointer("pointerover",slow);vi.advanceTimersByTime(21);await tick();
    const active=[...messages].reverse().find((x:any)=>x.type==="LINKPEEK_SCAN"&&x.url.includes("slow"));
    runtimeListeners[0]({type:"NO"});runtimeListeners[0]({type:"LINKPEEK_SCAN_PROGRESS",token:"bad",url:active.url,result:scan(active.url)});
    runtimeListeners[0]({type:"LINKPEEK_SCAN_PROGRESS",token:active.token,url:active.url,result:scan(active.url)});expect(viewer.show).toHaveBeenCalled();
    const newer=link("newer","https://x.test/newer");pointer("pointerover",newer);vi.advanceTimersByTime(21);await tick();
    resolve?.(scan(active.url));await tick();
  });

  it("honors continue-after-close policies and pinning",async()=>{
    sendImpl=async(msg:any)=>msg.type==="LINKPEEK_SCAN"?await new Promise(()=>{}):{ok:true};
    for(const mode of ["no","brief","always"] as const){
      await update({activationMode:"hover",continueAfterClose:mode});
      const a=link(mode,`https://x.test/${mode}`);pointer("pointerover",a);vi.advanceTimersByTime(21);await tick();
      a.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:document.body}));
      if(mode==="brief")vi.advanceTimersByTime(1001);
    }
    expect(messages.some(x=>x.type==="LINKPEEK_CANCEL_SCAN")).toBe(true);
    viewer.pinned=true;const p=link("pinned","https://x.test/pinned");pointer("pointerover",p);vi.advanceTimersByTime(21);await tick();p.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:document.body}));vi.advanceTimersByTime(20);
  });

  it("prefetches only visible Discourse candidates within mode budgets",async()=>{
    const visible={left:10,top:10,right:100,bottom:30},off={left:10,top:innerHeight*3,right:100,bottom:innerHeight*3+20};
    for(let i=0;i<8;i++)link(`d${i}`,`https://forum.test/t/topic/${100+i}`,i===7?off:visible);
    link("generic","https://x.test/page",visible);
    expect(idleCb).toBeTruthy();idleCb!({didTimeout:false,timeRemaining:()=>20});await tick();
    const pref=messages.filter(x=>x.type==="LINKPEEK_PREFETCH");expect(pref.length).toBeGreaterThan(0);expect(pref.length).toBeLessThanOrEqual(2);
  });
});

describe("content boot without prefetch",()=>{
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML=""});
  it("does not schedule idle prefetch when disabled/off",async()=>{
    vi.resetModules();vm.instances.length=0;
    const idle=vi.fn();
    vi.stubGlobal("requestIdleCallback",idle);
    settingsHarness.current={...DEFAULT_SETTINGS,prefetch:"off"};
    vi.stubGlobal("chrome",{
      storage:{local:{get:vi.fn(async(k:string)=>({[k]:k==="settings"?settingsHarness.current:undefined}))},onChanged:{addListener:vi.fn()}},
      runtime:{onMessage:{addListener:vi.fn()},sendMessage:vi.fn(async()=>({}))}
    });
    await import("../../src/content");await Promise.resolve();await Promise.resolve();expect(idle).not.toHaveBeenCalled();
  });
});
