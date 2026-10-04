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
    host=document.createElement("div");pinned=false;closeTimer:any;isOpen=false;onDismiss?:()=>void;
    restoreViewerState=vi.fn();key=vi.fn(()=>false);show=vi.fn();containsPoint=vi.fn(()=>false);error=vi.fn();
    openLoading=vi.fn(()=>{this.isOpen=true});close=vi.fn(()=>{this.isOpen=false});
    constructor(){vm.instances.push(this)}
  }
}));

const scan=(url:string):ScanResult=>({url,kind:"generic",title:"x",items:[],complete:true,diagnostics:{adapter:"x",ignored:0,duplicates:0,warnings:[]}});
class WarmImage{decoding="";fetchPriority="";private value="";private listeners:Record<string,Array<()=>void>>={};addEventListener(type:string,cb:()=>void){(this.listeners[type]??=[]).push(cb)}set src(v:string){this.value=v;this.listeners.load?.forEach(cb=>cb())}get src(){return this.value}}

describe("content script runtime",()=>{
  let store:any,changed:Function[],runtimeListeners:Function[],messages:any[],idleCb:Function|undefined,viewer:any,docListeners:Array<{type:string;listener:EventListenerOrEventListenerObject;options:any}>;
  let sendImpl:(msg:any)=>Promise<any>;
  const tick=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve()};

  beforeEach(async()=>{
    vi.resetModules();vi.useFakeTimers();vm.instances.length=0;document.body.innerHTML="";
    store={settings:{...DEFAULT_SETTINGS,hoverDelay:20,closeDelay:10,prefetch:"nearby"},viewerState:{view:"grid",gridThumbSize:90,expanded:false}};
    settingsHarness.current=store.settings;
    changed=[];runtimeListeners=[];messages=[];idleCb=undefined;docListeners=[];
    const add=document.addEventListener.bind(document);
    vi.spyOn(document,"addEventListener").mockImplementation(((type:string,listener:EventListenerOrEventListenerObject,options?:boolean|AddEventListenerOptions)=>{
      docListeners.push({type,listener,options});add(type,listener,options);
    }) as typeof document.addEventListener);
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
    vi.stubGlobal("Image",WarmImage as any);
    await import("../../src/content");await tick();viewer=vm.instances.at(-1);
  });
  afterEach(()=>{for(const {type,listener,options} of docListeners)document.removeEventListener(type,listener,options);vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML=""});

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

  it("can immediately re-arm the same link after movement cancels intent",async()=>{
    const a=link("same-rearm","https://x.test/same-rearm");pointer("pointerover",a,10,10);pointer("pointermove",a,100,100);pointer("pointerover",a,100,100);vi.advanceTimersByTime(21);await tick();expect(messages.some(x=>x.type==="LINKPEEK_SCAN"&&x.url===a.href)).toBe(true);
  });

  it("ignores child transitions and the viewer bridge, then closes on a real leave",async()=>{
    const a=link("parent","https://x.test/parent"),child=document.createElement("span");a.appendChild(child);
    pointer("pointerover",child);vi.advanceTimersByTime(21);await tick();
    pointer("pointerout",child,20,20,{relatedTarget:a});expect(viewer.close).not.toHaveBeenCalled();
    a.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:viewer.host}));expect(viewer.close).not.toHaveBeenCalled();
    a.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:document.body}));vi.advanceTimersByTime(11);expect(viewer.close).toHaveBeenCalled();
  });

  it("ignores clicks while activation mode is hover",async()=>{
    const a=link("hover-click","https://x.test/hover-click");
    const ev=new MouseEvent("click",{bubbles:true,cancelable:true,clientX:10,clientY:10});a.dispatchEvent(ev);await tick();
    expect(ev.defaultPrevented).toBe(false);expect(messages.some(x=>x.url?.includes("hover-click"))).toBe(false);
  });

  it("supports modifier hover and click activation modes",async()=>{
    const a=link("mod","https://x.test/mod");
    await update({activationMode:"modifier"});
    pointer("pointerover",a);pointer("pointerover",a);pointer("pointermove",a,19,19,{altKey:false});vi.advanceTimersByTime(30);await tick();expect(messages.some(x=>x.type==="LINKPEEK_SCAN"&&x.url?.includes("mod"))).toBe(false);
    pointer("pointermove",a,20,20,{altKey:true});vi.advanceTimersByTime(25);await tick();expect(messages.some(x=>x.type==="LINKPEEK_SCAN"&&x.url?.includes("mod"))).toBe(true);
    pointer("pointermove",a,21,21,{altKey:false});
    await update({activationMode:"click"});
    const b=link("click","https://x.test/click");const ev=new MouseEvent("click",{bubbles:true,cancelable:true,clientX:30,clientY:30});b.dispatchEvent(ev);await tick();
    expect(ev.defaultPrevented).toBe(true);expect(messages.some(x=>x.url?.includes("click"))).toBe(true);
    const scans=messages.filter(x=>x.type==="LINKPEEK_SCAN"&&x.url===b.href).length;b.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,clientX:31,clientY:31}));await tick();expect(messages.filter(x=>x.type==="LINKPEEK_SCAN"&&x.url===b.href)).toHaveLength(scans);
    document.body.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    document.dispatchEvent(new MouseEvent("click",{bubbles:true}));
  });

  it("replaces an in-flight click preview with an explicitly clicked link",async()=>{
    await update({activationMode:"click"});let release!:(value:any)=>void;sendImpl=async msg=>msg.type==="LINKPEEK_SCAN"&&msg.url.includes("first-click")?await new Promise(resolve=>{release=resolve}):msg.type==="LINKPEEK_SCAN"?scan(msg.url):{ok:true};
    const first=link("first-click","https://x.test/first-click"),second=link("second-click","https://x.test/second-click");first.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));await tick();second.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));await tick();expect(messages.some(x=>x.type==="LINKPEEK_CANCEL_SCAN"&&x.url===first.href)).toBe(true);release(scan(first.href));
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

  it("clears hover timers and keeps a pinned preview stable",async()=>{
    const immediate=link("immediate","https://x.test/immediate");
    pointer("pointerover",immediate,10,10);
    immediate.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:document.body}));

    const moving=link("moving-clear","https://x.test/moving-clear");
    pointer("pointerover",moving,10,10);pointer("pointermove",moving,200,200);
    moving.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:document.body}));
    vi.advanceTimersByTime(200);await tick();

    let resolveSlow!:(v:any)=>void;
    sendImpl=async(msg:any)=>{
      if(msg.type==="LINKPEEK_SCAN"&&msg.url.includes("pinned-slow"))return await new Promise(r=>{resolveSlow=r});
      if(msg.type==="LINKPEEK_SCAN")return scan(msg.url);
      return {ok:true};
    };
    const slow=link("pinned-slow","https://x.test/pinned-slow");pointer("pointerover",slow);vi.advanceTimersByTime(21);await tick();
    viewer.pinned=true;
    const next=link("pinned-next","https://x.test/pinned-next");pointer("pointerover",next);vi.advanceTimersByTime(21);await tick();
    expect(messages.some(x=>x.type==="LINKPEEK_CANCEL_SCAN"&&x.url.includes("pinned-slow"))).toBe(false);
    expect(messages.some(x=>x.type==="LINKPEEK_SCAN"&&x.url.includes("pinned-next"))).toBe(false);
    resolveSlow?.(scan(slow.href));await tick();viewer.pinned=false;
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

  it("covers no-anchor/click-mode guards, empty labels and repeated same-anchor hover",async()=>{
    document.body.dispatchEvent(new MouseEvent("pointerover",{bubbles:true,clientX:1,clientY:1}));
    document.body.dispatchEvent(new MouseEvent("pointermove",{bubbles:true,clientX:2,clientY:2}));
    document.body.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:null}));
    await update({activationMode:"click"});
    const clickOnly=link("click-only","https://x.test/click-only");pointer("pointerover",clickOnly);vi.advanceTimersByTime(30);await tick();
    expect(messages.some(x=>x.url?.includes("click-only"))).toBe(false);

    await update({activationMode:"hover"});
    const empty=link("empty","https://x.test/empty");empty.textContent="";
    pointer("pointerover",empty);pointer("pointerover",empty);vi.advanceTimersByTime(25);await tick();
    expect(viewer.openLoading).toHaveBeenCalledWith(expect.any(Number),expect.any(Number),expect.any(Object),"Scanning link…");

    const other=link("other","https://x.test/other");
    other.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:document.body}));
  });

  it("covers visible/all prefetch budgets, duplicate-prefetch skipping and disabled guard",async()=>{
    const visible={left:10,top:10,right:100,bottom:30};
    for(let i=0;i<20;i++)link(`pv${i}`,`https://forum.test/t/prefetch/${500+i}`,visible);
    const before=messages.filter(x=>x.type==="LINKPEEK_PREFETCH").length;
    idleCb!({didTimeout:false,timeRemaining:()=>20});await tick();
    const nearby=messages.filter(x=>x.type==="LINKPEEK_PREFETCH").length-before;expect(nearby).toBeLessThanOrEqual(3);
    const same=messages.filter(x=>x.type==="LINKPEEK_PREFETCH").length;
    idleCb!({didTimeout:false,timeRemaining:()=>20});await tick();expect(messages.filter(x=>x.type==="LINKPEEK_PREFETCH").length).toBeGreaterThanOrEqual(same);

    await update({prefetch:"visible"});
    for(let i=0;i<8;i++)link(`vis${i}`,`https://forum.test/t/visible/${600+i}`,visible);
    const v0=messages.filter(x=>x.type==="LINKPEEK_PREFETCH").length;idleCb!({didTimeout:false,timeRemaining:()=>20});await tick();
    expect(messages.filter(x=>x.type==="LINKPEEK_PREFETCH").length-v0).toBeLessThanOrEqual(6);

    await update({prefetch:"all"});
    for(let i=0;i<14;i++)link(`all${i}`,`https://forum.test/t/all/${700+i}`,visible);
    const a0=messages.filter(x=>x.type==="LINKPEEK_PREFETCH").length;idleCb!({didTimeout:false,timeRemaining:()=>20});await tick();
    expect(messages.filter(x=>x.type==="LINKPEEK_PREFETCH").length-a0).toBeLessThanOrEqual(12);

    await update({enabled:false});
    const d0=messages.filter(x=>x.type==="LINKPEEK_PREFETCH").length;idleCb!({didTimeout:false,timeRemaining:()=>20});await tick();
    expect(messages.filter(x=>x.type==="LINKPEEK_PREFETCH")).toHaveLength(d0);
  });

  it("prefetches visible media-capable links within mode budgets",async()=>{
    const visible={left:10,top:10,right:100,bottom:30},off={left:10,top:innerHeight*3,right:100,bottom:innerHeight*3+20};
    for(let i=0;i<8;i++)link(`d${i}`,`https://forum.test/t/topic/${100+i}`,i===7?off:visible);
    link("generic","https://x.test/page",visible);
    expect(idleCb).toBeTruthy();idleCb!({didTimeout:false,timeRemaining:()=>20});await tick();
    const pref=messages.filter(x=>x.type==="LINKPEEK_PREFETCH");expect(pref.length).toBeGreaterThan(0);expect(pref.length).toBeLessThanOrEqual(3);
  });

  it("bounds speculative work, warms preview images and handles viewer ownership",async()=>{
    const media=(url:string,n:number):ScanResult=>({...scan(url),items:Array.from({length:n},(_,i)=>({id:`${url}-${i}`,type:"image",originalUrl:`${url}/o${i}.jpg`,previewUrl:`${url}/p${i}.jpg`,sourceUrl:url,score:1}))});
    let releases:Array<(value:any)=>void>=[];
    sendImpl=async msg=>msg.type==="LINKPEEK_PREFETCH"?await new Promise(resolve=>releases.push(resolve)):msg.type==="LINKPEEK_SCAN"?scan(msg.url):{ok:true};
    const links=[0,1,2].map(i=>link(`warm-${i}`,`https://warm${i}.test/page`));links.forEach(a=>pointer("pointerover",a));await tick();
    expect(messages.filter(x=>x.type==="LINKPEEK_PREFETCH")).toHaveLength(2);
    releases.shift()!(media(links[0].href,3));await tick();expect(messages.filter(x=>x.type==="LINKPEEK_PREFETCH")).toHaveLength(3);
    releases.splice(0).forEach((resolve,i)=>resolve(media(links[i+1]?.href??links[0].href,3)));await tick();

    sendImpl=async msg=>msg.type==="LINKPEEK_PREFETCH"?media(msg.url,3):msg.type==="LINKPEEK_SCAN"?scan(msg.url):{ok:true};
    for(let i=3;i<12;i++){const a=link(`warm-${i}`,`https://warm${i}.test/page`);pointer("pointerover",a);await tick()}
    const duplicate=media("https://duplicate.test/page",3);duplicate.items[1].previewUrl=duplicate.items[0].previewUrl;duplicate.items[2].previewUrl="";sendImpl=async msg=>msg.type==="LINKPEEK_PREFETCH"?duplicate:msg.type==="LINKPEEK_SCAN"?scan(msg.url):{ok:true};const duplicateLink=link("duplicate","https://duplicate.test/page");pointer("pointerover",duplicateLink);await tick();
    await update({networkMode:"data",idlePrefetch:false});const data=link("data","https://data.test/page");pointer("pointerover",data);await tick();
    document.dispatchEvent(new Event("scroll",{bubbles:true}));vi.advanceTimersByTime(181);await tick();

    viewer.host.textContent="viewer";document.body.appendChild(viewer.host);viewer.closeTimer=123;pointer("pointerover",viewer.host);viewer.containsPoint.mockReturnValueOnce(true);viewer.closeTimer=124;pointer("pointermove",document.body,50,50);expect(viewer.containsPoint).toHaveBeenCalled();
    sendImpl=async msg=>{if(msg.type==="LINKPEEK_PREFETCH")throw new Error("warm failed");return msg.type==="LINKPEEK_SCAN"?new Promise(()=>{}):{ok:true}};
    const retry=link("retry","https://retry.test/page");pointer("pointerover",retry);await tick();pointer("pointerover",retry);await tick();expect(messages.filter(x=>x.type==="LINKPEEK_PREFETCH"&&x.url===retry.href).length).toBe(2);
    vi.advanceTimersByTime(25);await tick();viewer.onDismiss?.();vi.advanceTimersByTime(1001);expect(messages.some(x=>x.type==="LINKPEEK_CANCEL_SCAN")).toBe(true);
    Object.defineProperty(document,"hidden",{configurable:true,value:true});const hidden=link("hidden","https://hidden.test/page");pointer("pointerover",hidden);pointer("pointermove",hidden);document.dispatchEvent(new Event("scroll"));await tick();
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
