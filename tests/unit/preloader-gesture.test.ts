import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../../src/shared/settings";
import {buildPreloadPlan,MediaPreloader} from "../../src/ui/media-preloader";
import {GestureController} from "../../src/ui/gesture";
import type {MediaItem} from "../../src/shared/media";

const item=(n:number,type:"image"|"gif"="image"):MediaItem=>({
  id:String(n),type,originalUrl:`https://x.test/original-${n}.${type==="gif"?"gif":"jpg"}`,
  previewUrl:`https://x.test/preview-${n}.${type==="gif"?"gif":"jpg"}`,sourceUrl:"https://x.test",score:1
});

class FakeImage extends EventTarget{
  decoding="";fetchPriority="";naturalWidth=4000;naturalHeight=4000;_src="";
  decode=vi.fn(async()=>{if(this._src.includes("decodefail"))throw new Error("decode")});
  set src(value:string){this._src=value;queueMicrotask(()=>this.dispatchEvent(new Event(value.includes("fail")?"error":"load")))}
  get src(){return this._src}
}

class FakePointerEvent extends MouseEvent{
  pointerId:number;
  constructor(type:string,init:MouseEventInit&{pointerId?:number}={}){super(type,init);this.pointerId=init.pointerId??1}
}

describe("preload planning",()=>{
  it("handles empty, wraparound, data saver, directions, rest limits and original policies",()=>{
    const base={...DEFAULT_SETTINGS,preloadNext:2,preloadPrevious:2,preloadRest:"idle" as const,preloadRestLimit:20,preloadOriginals:"next" as const,networkMode:"adaptive" as const,loopMode:"wrap" as const};
    expect(buildPreloadPlan(0,0,base)).toEqual({priority:[],background:[],originals:[]});
    const wrap=buildPreloadPlan(5,0,base);
    expect(wrap.priority).toEqual([1,4,2,3]);expect(wrap.originals).toEqual([1]);expect(wrap.background).toEqual([]);
    const forward=buildPreloadPlan(8,3,{...base,preloadRest:"all"},1);
    expect(forward.priority.slice(0,3)).toEqual([4,2,5]);expect(forward.originals).toEqual([4]);
    const backward=buildPreloadPlan(8,3,{...base,preloadOriginals:"three",preloadRest:"all"},-1);
    expect(backward.priority[0]).toBe(4);expect(backward.originals).toEqual([2,1,0]);
    const aggressive=buildPreloadPlan(8,3,{...base,preloadOriginals:"aggressive",preloadRest:"all"},1);
    expect(aggressive.originals).toEqual(expect.arrayContaining(aggressive.priority));
    const data=buildPreloadPlan(8,3,{...base,networkMode:"data",preloadRest:"all"},1);
    expect(data.priority).toEqual([4,2]);expect(data.background).toEqual([]);
    const tooLarge=buildPreloadPlan(50,4,{...base,preloadRestLimit:10,preloadRest:"idle"},0);
    expect(tooLarge.background).toEqual([]);
    const noRest=buildPreloadPlan(8,3,{...base,preloadRest:"off",preloadOriginals:"never"},0);
    expect(noRest.background).toEqual([]);expect(noRest.originals).toEqual([]);
    const stop=buildPreloadPlan(4,0,{...base,loopMode:"stop"},0);
    expect(stop.priority).toEqual([1,2]);expect(stop.originals).toEqual([1]);
  });
});

describe("MediaPreloader",()=>{
  let sent:any[];
  beforeEach(()=>{
    sent=[];
    vi.stubGlobal("Image",FakeImage as any);
    vi.stubGlobal("chrome",{runtime:{sendMessage:vi.fn(async(msg:any)=>{sent.push(msg);return {ok:true}})}});
    Object.defineProperty(navigator,"connection",{configurable:true,value:undefined});
  });
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()});

  it("preloads, decodes, reuses elements, warms GIFs and disposes",async()=>{
    const p=new MediaPreloader();
    p.schedule(0);
    const items=[item(0),item(1),item(2,"gif"),item(3)];
    const settings={...DEFAULT_SETTINGS,preloadRest:"off" as const,preloadNext:3,preloadPrevious:1,preloadConcurrency:2,preloadMemoryMb:256};
    p.reset(items,0,settings);
    await new Promise(r=>setTimeout(r,0));
    await p.ensure(items[1]);
    expect(p.isReady(items[1])).toBe(true);
    expect(p.element(items[1])).toBeTruthy();
    expect(p.element(item(99))).toBeUndefined();
    await p.ensure(items[2]);expect(sent.some(x=>x.type==="LINKPEEK_PREFETCH_BINARY")).toBe(true);
    expect(p.isReady(items[2])).toBe(true);
    p.schedule(1,1);p.schedule(0,-1);
    p.dispose();expect(p.element(items[1])).toBeUndefined();
  });

  it("handles idle/all background work, constrained connections, decode failures and image errors",async()=>{
    const idle=vi.fn((cb:IdleRequestCallback)=>{cb({didTimeout:false,timeRemaining:()=>50} as IdleDeadline);return 7});
    const cancel=vi.fn();
    Object.defineProperty(window,"requestIdleCallback",{configurable:true,value:idle});
    Object.defineProperty(window,"cancelIdleCallback",{configurable:true,value:cancel});
    const p=new MediaPreloader(),items=[item(0),item(1),item(2),item(3)];
    p.reset(items,1,{...DEFAULT_SETTINGS,preloadRest:"idle",preloadRestLimit:20,preloadNext:1,preloadPrevious:0,preloadConcurrency:1,preloadMemoryMb:32});
    await new Promise(r=>setTimeout(r,0));expect(idle).toHaveBeenCalled();
    p.reset(items,1,{...DEFAULT_SETTINGS,preloadRest:"all",preloadRestLimit:20,preloadNext:1,preloadPrevious:0,preloadConcurrency:8,preloadMemoryMb:32});
    await new Promise(r=>setTimeout(r,0));
    Object.defineProperty(navigator,"connection",{configurable:true,value:{saveData:true,effectiveType:"2g"}});
    p.reset(items,1,{...DEFAULT_SETTINGS,meteredOff:true,preloadRest:"all",preloadNext:8,preloadPrevious:8});
    await new Promise(r=>setTimeout(r,0));

    const decodeFail={...item(9),previewUrl:"https://x.test/decodefail.jpg"};
    await p.ensure(decodeFail);expect(p.isReady(decodeFail)).toBe(true);
    const fail={...item(10),previewUrl:"https://x.test/fail.jpg"};
    await p.ensure(fail);expect(p.isReady(fail)).toBe(false);
    p.dispose();expect(cancel).toHaveBeenCalled();
  });

  it("uses timeout fallback when idle callbacks are unavailable and evicts outside the memory ring",async()=>{
    Object.defineProperty(window,"requestIdleCallback",{configurable:true,value:undefined});
    const timeout=vi.spyOn(window,"setTimeout").mockImplementation(((cb:any)=>{cb();return 1}) as any);
    const p=new MediaPreloader(),items=Array.from({length:12},(_,i)=>item(i));
    p.reset(items,5,{...DEFAULT_SETTINGS,preloadRest:"idle",preloadRestLimit:20,preloadNext:1,preloadPrevious:1,preloadConcurrency:8,preloadMemoryMb:32});
    await new Promise<void>(resolve=>queueMicrotask(resolve));
    expect(timeout).toHaveBeenCalled();
    p.schedule(10,1);
    await p.ensure(items[10]);
    expect(p.isReady(items[10])).toBe(true);
    p.dispose();
  });
});

describe("GestureController",()=>{
  let el:HTMLElement,cb:any,settings:any;
  beforeEach(()=>{
    vi.stubGlobal("PointerEvent",FakePointerEvent as any);
    el=document.createElement("div");document.body.appendChild(el);
    (el as any).setPointerCapture=vi.fn();(el as any).hasPointerCapture=vi.fn(()=>true);(el as any).releasePointerCapture=vi.fn();
    cb={next:vi.fn(),previous:vi.fn(),zoom:vi.fn(),pan:vi.fn(),scrub:vi.fn(),doubleClick:vi.fn(),isZoomed:vi.fn(()=>false)};
    settings={...DEFAULT_SETTINGS,gestureThreshold:20,navSensitivity:.5,momentumFiltering:false,fastSwipeAcceleration:true,maxImagesPerSwipe:3};
  });
  afterEach(()=>{document.body.innerHTML="";vi.restoreAllMocks();vi.unstubAllGlobals()});

  const wheel=(dx:number,dy:number,extra:WheelEventInit={})=>el.dispatchEvent(new WheelEvent("wheel",{deltaX:dx,deltaY:dy,cancelable:true,...extra}));
  const pointer=(type:string,x:number,y:number,id=1,button=0)=>el.dispatchEvent(new FakePointerEvent(type,{clientX:x,clientY:y,pointerId:id,button,bubbles:true,cancelable:true}));

  it("handles pinch zoom, zoomed panning and disabled scroll modes",()=>{
    const g=new GestureController(el,cb,settings);
    wheel(0,20,{ctrlKey:true});expect(cb.zoom).toHaveBeenCalled();
    cb.isZoomed.mockReturnValue(true);wheel(10,20);expect(cb.pan).toHaveBeenCalled();
    cb.isZoomed.mockReturnValue(false);settings.horizontalGesture="disabled";wheel(100,1);expect(cb.scrub).not.toHaveBeenCalled();
    settings.verticalGesture="disabled";wheel(0,100);expect(cb.next).not.toHaveBeenCalled();
    settings.verticalGesture="scroll";wheel(0,100);expect(cb.next).not.toHaveBeenCalled();
    g.destroy();
  });

  it("navigates/scrubs in every direction, acceleration and momentum mode",()=>{
    let g=new GestureController(el,cb,settings);
    wheel(100,1);expect(cb.scrub).toHaveBeenCalledWith(100);
    settings.horizontalGesture="navigate";settings.reverseHorizontal=true;wheel(100,1);expect(cb.previous).toHaveBeenCalled();
    settings.reverseHorizontal=false;wheel(100,1);expect(cb.next).toHaveBeenCalled();
    settings.verticalGesture="pan";wheel(0,100);expect(cb.pan).toHaveBeenCalled();
    settings.verticalGesture="navigate";settings.reverseVertical=true;wheel(0,100);expect(cb.previous).toHaveBeenCalled();
    settings.reverseVertical=false;settings.fastSwipeAcceleration=false;wheel(0,100);expect(cb.next).toHaveBeenCalledWith(1);
    g.destroy();

    settings.momentumFiltering=true;settings.gestureCooldown=1000;g=new GestureController(el,cb,settings);
    const before=cb.next.mock.calls.length;wheel(0,100);wheel(0,100);expect(cb.next.mock.calls.length-before).toBe(1);
    g.destroy();
  });

  it("supports double-click, disabled double-click and double-click-hold drag panning",()=>{
    cb.isZoomed.mockReturnValue(true);
    const g=new GestureController(el,cb,settings);
    pointer("pointerup",20,20);pointer("pointerdown",21,21,1,1);
    pointer("pointerdown",21,21);pointer("pointermove",21,21);pointer("pointermove",35,40);
    expect(cb.pan).toHaveBeenCalledWith(14,19);
    pointer("pointerup",35,40);
    el.dispatchEvent(new MouseEvent("dblclick",{clientX:35,clientY:40,bubbles:true,cancelable:true}));
    expect(cb.doubleClick).not.toHaveBeenCalled();
    pointer("pointercancel",35,40,2);
    g.destroy();

    settings.doubleClickDragPan=false;const g2=new GestureController(el,cb,settings);
    el.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true}));expect(cb.doubleClick).toHaveBeenCalled();
    settings.doubleClick="none";el.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true}));
    const calls=cb.doubleClick.mock.calls.length;expect(calls).toBeGreaterThan(0);
    g2.destroy();
  });
});
