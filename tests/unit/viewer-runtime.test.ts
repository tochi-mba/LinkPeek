import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {Viewer} from "../../src/ui/viewer";
import {DEFAULT_SETTINGS} from "../../src/shared/settings";
import type {MediaItem,ScanResult} from "../../src/shared/media";

const item=(n:number,type:"image"|"gif"="image"):MediaItem=>({
  id:`i${n}`,type,originalUrl:`https://x.test/o${n}.${type==="gif"?"gif":"jpg"}`,
  previewUrl:`https://x.test/p${n}.${type==="gif"?"gif":"jpg"}`,sourceUrl:"https://x.test/source",filename:`f${n}`,postNumber:n+1,score:1
});
const result=(items:MediaItem[],complete=true,url="https://forum.test/t/a/1"):ScanResult=>({
  url,kind:"discourse",title:"Topic",items,complete,postsScanned:complete?10:2,totalPosts:10,
  diagnostics:{adapter:"Discourse",ignored:0,duplicates:0,warnings:[]}
});
const tick=()=>new Promise<void>(r=>queueMicrotask(r));

class RO{constructor(private cb:ResizeObserverCallback){}observe(){}disconnect(){}unobserve(){}}
class PE extends MouseEvent{pointerId=1}

describe("Viewer runtime",()=>{
  let store:Record<string,any>,messages:any[];
  beforeEach(()=>{
    document.body.innerHTML="";store={favorites:[]};messages=[];
    vi.stubGlobal("ResizeObserver",RO as any);
    vi.stubGlobal("PointerEvent",PE as any);
    vi.stubGlobal("requestAnimationFrame",(cb:FrameRequestCallback)=>{cb(0);return 1});
    vi.stubGlobal("cancelAnimationFrame",vi.fn());
    Object.defineProperty(window,"innerWidth",{configurable:true,value:1200});
    Object.defineProperty(window,"innerHeight",{configurable:true,value:900});
    vi.stubGlobal("chrome",{
      storage:{local:{
        get:vi.fn(async(k:string)=>({[k]:store[k]})),
        set:vi.fn(async(v:any)=>Object.assign(store,v))
      }},
      runtime:{
        getURL:vi.fn((x:string)=>x),
        sendMessage:vi.fn(async(msg:any)=>{messages.push(msg);return {ok:true}})
      }
    });
    vi.spyOn(window,"open").mockImplementation(()=>null);
  });
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML=""});

  function make(settings:any={}) {
    const v=new Viewer();
    const preload={
      reset:vi.fn(),dispose:vi.fn(),schedule:vi.fn(),ensure:vi.fn(async()=>{}),
      isReady:vi.fn(()=>false),element:vi.fn()
    };
    (v as any).preloader=preload;
    v.openLoading(100,100,{...DEFAULT_SETTINGS,preloadNext:0,preloadPrevious:0,preloadRest:"off",...settings},"Link");
    return {v,preload};
  }

  it("restores/persists viewer state and toggles grid, density and expansion controls",async()=>{
    const {v}=make();
    v.restoreViewerState({view:"grid",gridThumbSize:999,expanded:true});
    v.openLoading(20,20,{...DEFAULT_SETTINGS,quickViewControls:true},"Again");
    expect(v.view).toBe("grid");expect((v as any).gridThumbSize).toBe(320);
    v.show(result([item(0),item(1)]));
    expect(v.panel.querySelector(".lp-gridbtn")?.getAttribute("aria-label")).toBe("Back to single image");
    (v.panel.querySelector(".lp-gridbtn") as HTMLButtonElement).click();
    expect(v.view).toBe("focus");
    expect(store.viewerState.view).toBe("focus");
    (v.panel.querySelector(".lp-expandbtn") as HTMLButtonElement).click();expect(store.viewerState.expanded).toBe(false);
    v.key(new KeyboardEvent("keydown",{key:"g"}));expect(v.view).toBe("grid");
    (v.panel.querySelector(".lp-grid-more") as HTMLButtonElement).click();
    (v.panel.querySelector(".lp-grid-bigger") as HTMLButtonElement).click();
    expect(store.viewerState.gridThumbSize).toBeGreaterThanOrEqual(48);
    v.close(true);
  });

  it("merges progressive results without losing media/duplicates and exposes scan state",async()=>{
    const {v}=make();
    v.view="grid";
    v.show(result([item(0),item(1)],false));
    expect(v.panel.querySelector(".lp-grid-progress")?.textContent).toContain("Scanning thread");
    v.show({...result([item(1),item(2)],true),postsScanned:10});
    expect(v.result?.items).toHaveLength(3);expect(v.result?.complete).toBe(true);
    expect(v.panel.querySelector(".lp-grid-progress")).toBeNull();
    v.show(result([item(9)],true,"https://other.test/page"));expect(v.result?.items).toHaveLength(1);
    v.close(true);
  });

  it("keeps a progressive focus view stable and exposes a forgiving pointer bridge",()=>{
    const {v,preload}=make();
    expect(v.isOpen).toBe(true);
    Object.defineProperty(v.panel,"getBoundingClientRect",{configurable:true,value:()=>({left:100,top:100,right:500,bottom:500,width:400,height:400,x:100,y:100,toJSON(){}})});
    expect(v.containsPoint(120,120)).toBe(true);expect(v.containsPoint(900,900)).toBe(false);expect(v.containsPoint(90,30,{left:10,top:10,right:80,bottom:40} as DOMRect)).toBe(true);
    v.settings={...v.settings,magneticBridge:false};expect(v.containsPoint(90,30,{left:10,top:10,right:80,bottom:40} as DOMRect)).toBe(false);
    v.settings={...v.settings,magneticBridge:true};
    const first=result([item(0)],false);first.postsScanned=undefined;first.totalPosts=undefined;v.show(first);const stage=v.panel.querySelector(".lp-stage");
    const next=result([item(0),item(1)],false);next.postsScanned=undefined;next.totalPosts=undefined;v.show(next);expect(v.panel.querySelector(".lp-stage")).toBe(stage);expect(preload.reset).toHaveBeenCalled();expect(v.panel.textContent).toContain("0/? posts");
    const final={...next,complete:true,postsScanned:10};v.show(final);expect(v.panel.querySelector(".lp-stage")).toBe(stage);expect(v.panel.textContent).toContain("Complete");
    v.close(true);expect(v.isOpen).toBe(false);expect(v.containsPoint(120,120)).toBe(false);
  });

  it("renders focus images, decoded element reuse, errors, empty results and pinned close behavior",async()=>{
    const {v,preload}=make();
    v.show(result([item(0)]));expect(v.panel.querySelector("img.lp-image")).toBeTruthy();
    const decoded=document.createElement("img");preload.isReady.mockReturnValue(true);preload.element.mockReturnValue(decoded);
    v.show(result([item(0)]));expect(v.panel.querySelector(".lp-image")).toBe(decoded);
    v.show(result([],true,"https://empty.test/page"));expect(v.panel.textContent).toContain("No posted media");
    v.error("<bad>");expect(v.panel.innerHTML).toContain("&lt;bad&gt;");
    v.pinned=true;v.close();expect(v.root.childElementCount).toBe(1);
    v.close(true);expect(v.root.childElementCount).toBe(0);expect(preload.dispose).toHaveBeenCalled();
  });

  it("handles all keyboard actions, zoom/pan and double-click behaviors",async()=>{
    vi.useFakeTimers();
    const {v}=make({doubleClick:"zoom"});
    v.show(result([item(0),item(1)]));
    expect(v.key(new KeyboardEvent("keydown",{key:"x"}))).toBe(false);
    expect(v.key(new KeyboardEvent("keydown",{key:"p"}))).toBe(true);expect(v.pinned).toBe(true);
    v.key(new KeyboardEvent("keydown",{key:"?"}));expect(v.help).toBe(true);expect(v.key(new KeyboardEvent("keydown",{key:"o"}))).toBe(false);v.key(new KeyboardEvent("keydown",{key:"?"}));
    v.key(new KeyboardEvent("keydown",{key:"o"}));expect(window.open).toHaveBeenCalled();
    v.key(new KeyboardEvent("keydown",{key:"d"}));expect(messages.some(x=>x.type==="LINKPEEK_DOWNLOAD")).toBe(true);
    v.key(new KeyboardEvent("keydown",{key:"="}));expect(v.zoom).toBeGreaterThan(1);
    v.key(new KeyboardEvent("keydown",{key:"-"}));v.key(new KeyboardEvent("keydown",{key:"0"}));expect(v.zoom).toBe(1);
    v.pan(1,1);expect(v.tx).toBe(0);
    v.settings.verticalGesture="pan";v.pan(2,3);expect(v.tx).toBe(2);expect(v.ty).toBe(3);
    v.quickZoom(10,10);expect(v.zoom).toBeGreaterThan(1);v.quickZoom(10,10);expect(v.zoom).toBe(1);
    v.applyZoom(100,20,20);const max=v.zoom;v.applyZoom(2,20,20);expect(v.zoom).toBe(1);expect(max).toBe(v.settings.maxZoom);

    v.settings.doubleClick="next";v.onDoubleClick(1,1);await tick();
    v.settings.doubleClick="fullscreen";const req=vi.fn(async()=>{});(v.panel as any).requestFullscreen=req;v.onDoubleClick(1,1);expect(req).toHaveBeenCalled();
    Object.defineProperty(document,"fullscreenElement",{configurable:true,value:v.panel});const exit=vi.fn(async()=>{});(document as any).exitFullscreen=exit;v.onDoubleClick(1,1);expect(exit).toHaveBeenCalled();
    Object.defineProperty(document,"fullscreenElement",{configurable:true,value:null});
    v.settings.doubleClick="zoom";v.zoom=2;v.settings.secondDoubleClick="fit";v.onDoubleClick(1,1);expect(v.zoom).toBe(1);
    v.onDoubleClick(1,1);expect(v.zoom).toBeGreaterThan(1);
    vi.runAllTimers();vi.useRealTimers();
    v.close(true);
  });

  it("wraps/clamps navigation, waits for preload and ignores stale navigation",async()=>{
    const {v,preload}=make();
    v.show(result([item(0),item(1),item(2)]));
    v.index=0;v.settings.loopMode="wrap";v.move(-1);await tick();expect(v.index).toBe(2);expect(preload.schedule).toHaveBeenCalledWith(2,-1);
    v.move(1);await tick();expect(v.index).toBe(0);
    v.settings.loopMode="stop";v.index=0;v.move(-1);await tick();expect(v.index).toBe(0);
    v.index=2;v.move(1);await tick();expect(v.index).toBe(2);
    let resolve!:()=>void;preload.ensure.mockImplementationOnce(()=>new Promise<void>(r=>resolve=r));
    v.index=0;v.move(1);v.move(2);resolve();await tick();await tick();expect(v.index).toBe(2);
    v.show(result([],true,"https://empty.test/page"));v.move(1);await tick();expect(v.index).toBe(0);
    v.close(true);
  });

  it("virtualizes grids, handles clicks/scroll/cleanup and grid guard paths",()=>{
    const {v}=make();v.view="grid";v.show(result(Array.from({length:40},(_,i)=>item(i))));
    const grid=v.panel.querySelector(".lp-grid") as HTMLDivElement;
    Object.defineProperty(grid,"clientWidth",{configurable:true,value:500});Object.defineProperty(grid,"clientHeight",{configurable:true,value:300});
    (v as any).setupVirtualGrid();
    expect(v.panel.querySelectorAll(".lp-thumb").length).toBeGreaterThan(0);
    expect(v.panel.querySelectorAll(".lp-thumb").length).toBeLessThan(40);
    expect(v.panel.querySelector('.lp-thumb img[loading="eager"]')).toBeTruthy();expect(v.panel.querySelector('.lp-thumb img[loading="lazy"]')).toBeTruthy();expect(v.panel.querySelector(".lp-thumb")?.getAttribute("aria-label")).toContain("of 40");
    grid.dispatchEvent(new Event("scroll"));grid.dispatchEvent(new Event("scroll"));grid.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    const thumb=v.panel.querySelector(".lp-thumb") as HTMLButtonElement;thumb.click();expect(v.view).toBe("focus");
    v.view="grid";(v as any).render();
    (v as any).result=undefined;(v as any).setupVirtualGrid();
    (v as any).result=result([item(0)]);v.panel.innerHTML="";(v as any).setupVirtualGrid();
    v.close(true);
  });

  it("warms GIF neighborhood, mounts/falls back, and handles stale GIF mount",async()=>{
    const {v}=make({preloadNext:2,preloadPrevious:1});
    const fakePlayer={init:vi.fn(async()=>{}),destroy:vi.fn(),key:vi.fn(()=>false)};
    const prepare=vi.fn(async()=>{});
    (v as any).gifModulePromise=Promise.resolve({GifPlayer:class{init=fakePlayer.init;destroy=fakePlayer.destroy;key=fakePlayer.key},prepareGif:prepare});
    v.show(result([item(0,"gif"),item(1),item(2,"gif")]));
    await tick();await tick();expect(prepare).toHaveBeenCalled();
    await (v as any).mountGif(v.result!.items[0],(v as any).renderVersion);expect(fakePlayer.init).toHaveBeenCalled();
    await (v as any).mountGif(v.result!.items[0],-1);
    (v as any).gifModulePromise=Promise.reject(new Error("stale GIF module"));await (v as any).mountGif(v.result!.items[0],-1);

    (v as any).gifModulePromise=Promise.resolve({GifPlayer:class{constructor(){throw new Error("boom")}},prepareGif:vi.fn(async()=>{})});
    await (v as any).mountGif(v.result!.items[0],(v as any).renderVersion);expect(v.panel.textContent).toContain("Native GIF playback");
    (v as any).result=undefined;await (v as any).warmGifNeighborhood();
    v.close(true);
  });

  it("covers favorite success/remove/error, help variants, position edges and close timer bindings",async()=>{
    vi.useFakeTimers();
    const {v}=make({panelWidth:480,pointerGap:12,motion:"none",reducedMotion:true});
    v.show(result([item(0)]));await tick();
    expect(v.panel.querySelector(".lp-favorite")).toBeTruthy();
    v.key(new KeyboardEvent("keydown",{key:"b"}));await tick();expect(store.favorites).toHaveLength(1);
    v.key(new KeyboardEvent("keydown",{key:"b"}));await tick();expect(store.favorites).toHaveLength(0);
    const originalSet=(chrome.storage.local.set as any);originalSet.mockRejectedValueOnce(new Error("no"));
    v.key(new KeyboardEvent("keydown",{key:"b"}));await tick();expect(v.panel.textContent).toContain("1 / 1");
    (v as any).position(1190,890);expect(parseInt(v.panel.style.left)).toBeLessThan(1190);
    (v.panel.querySelector(".lp-helpbtn") as HTMLButtonElement).click();expect(v.help).toBe(true);
    v.show(result([item(0,"gif")],true,"https://gif.test/page"));expect((v as any).helpMarkup()).toContain("GIF play");
    v.panel.dispatchEvent(new MouseEvent("mouseenter"));v.pinned=false;v.panel.dispatchEvent(new MouseEvent("mouseleave"));vi.runAllTimers();
    vi.useRealTimers();v.close(true);
  });

  it("lets a GIF player consume keys before viewer shortcuts",()=>{
    const {v}=make();v.show(result([item(0)]));
    v.gifPlayer={init:async()=>{},destroy:()=>{},key:()=>true};
    expect(v.key(new KeyboardEvent("keydown",{key:"x"}))).toBe(true);
    v.close(true);expect(v.key(new KeyboardEvent("keydown",{key:"x"}))).toBe(false);
  });

  it("does not capture shortcuts while the page is being edited",()=>{
    const {v}=make();v.show(result([item(0)]));
    const input=document.createElement("input");document.body.appendChild(input);let handled=true;input.addEventListener("keydown",e=>handled=v.key(e));input.dispatchEvent(new KeyboardEvent("keydown",{key:"g",bubbles:true}));expect(handled).toBe(false);
    const editable=document.createElement("div");editable.setAttribute("contenteditable","true");document.body.appendChild(editable);editable.addEventListener("keydown",e=>handled=v.key(e));editable.dispatchEvent(new KeyboardEvent("keydown",{key:"g",bubbles:true}));expect(handled).toBe(false);
  });
  it("covers alternate focus rendering, metadata fallbacks and viewer gesture callbacks",async()=>{
    const {v,preload}=make({showLearningTips:false,quickViewControls:false});
    (v as any).render();
    const bare:ScanResult={
      url:"https://bare.test/path",kind:"generic",
      items:[{...item(0),filename:undefined}],complete:false
    };
    v.show(bare);expect(v.panel.textContent).toContain("bare.test");expect(v.panel.querySelector(".lp-tip")).toBeNull();
    expect(v.panel.querySelector(".lp-expandbtn")).toBeNull();

    preload.isReady.mockReturnValue(true);preload.element.mockReturnValue(undefined);
    v.show(bare);expect(v.panel.querySelector(".lp-image-slot")).toBeTruthy();
    const decoded=document.createElement("img");preload.element.mockReturnValue(decoded);
    v.show(bare);expect(decoded.alt).toBe("Preview image");

    v.view="grid";v.show({...bare,items:[item(0)]});
    expect(v.panel.querySelector(".lp-grid-progress")?.textContent).toContain("0/? posts");
    v.view="focus";

    const full=result([item(0),item(1),item(2),item(3)]);v.show(full);
    const destroy=vi.fn();v.gifPlayer={init:async()=>{},destroy,key:()=>false};(v as any).render();expect(destroy).toHaveBeenCalled();
    const callbacks=(v.gesture as any).cb;
    callbacks.next();await tick();callbacks.previous();await tick();
    callbacks.next(2);await tick();callbacks.previous(2);await tick();
    callbacks.scrub(1);await tick();callbacks.scrub(-1);await tick();
    callbacks.pan(3,4);callbacks.zoom(1.1,10,10);callbacks.doubleClick(10,10);
    expect(typeof callbacks.isZoomed()).toBe("boolean");

    v.show({...bare,items:[]});
    expect(v.key(new KeyboardEvent("keydown",{key:"o"}))).toBe(true);
    expect(v.key(new KeyboardEvent("keydown",{key:"d"}))).toBe(true);
    v.paintTransform();

    const dismissed=vi.fn();v.onDismiss=dismissed;v.close(true);expect(dismissed).toHaveBeenCalled();

    const masonry=make({defaultView:"masonry",quickViewControls:false}).v;
    expect(masonry.view).toBe("grid");masonry.close(true);
  });

  it("covers shortcut fallbacks, close/next/previous keys and fullscreen without request support",async()=>{
    const {v}=make();v.show(result([item(0),item(1)]));
    v.settings.shortcuts={};
    expect(v.key(new KeyboardEvent("keydown",{key:"ArrowDown"}))).toBe(true);await tick();
    expect(v.key(new KeyboardEvent("keydown",{key:"ArrowUp"}))).toBe(true);await tick();
    v.settings.doubleClick="fullscreen";(v.panel as any).requestFullscreen=undefined;v.onDoubleClick(1,1);
    expect(v.key(new KeyboardEvent("keydown",{key:"Escape"}))).toBe(true);
    expect(v.root.childElementCount).toBe(0);
  });

  it("covers favorite refresh races, title fallback and no-result guards",async()=>{
    const {v}=make();
    store.favorites=[{url:"https://forum.test/t/a/1",title:"Saved",addedAt:1}];
    v.show(result([item(0)]));await tick();await tick();
    expect(v.panel.querySelector(".lp-favorite")?.getAttribute("aria-pressed")).toBe("true");

    (chrome.storage.local.get as any).mockRejectedValueOnce(new Error("read"));
    await (v as any).refreshFavorite();

    let releaseGet!:(value:any)=>void;
    (chrome.storage.local.get as any).mockImplementationOnce(()=>new Promise(r=>{releaseGet=r}));
    const staleVersion=(v as any).refreshFavorite();(v as any).favoriteVersion++;
    releaseGet({favorites:[]});await staleVersion;

    let releaseGet2!:(value:any)=>void;
    (chrome.storage.local.get as any).mockImplementationOnce(()=>new Promise(r=>{releaseGet2=r}));
    const staleUrl=(v as any).refreshFavorite();(v as any).result={...v.result!,url:"https://changed.test/"};
    releaseGet2({favorites:[{url:"https://forum.test/t/a/1",title:"Saved",addedAt:1}]});await staleUrl;

    v.show({...result([item(0)],true,"https://titleless.test/a"),title:undefined});
    let releaseSet!:(value?:any)=>void;
    (chrome.storage.local.set as any).mockImplementationOnce(()=>new Promise(r=>{releaseSet=r}));
    const pending=(v as any).toggleFavorite();await tick();
    (v as any).result={...v.result!,url:"https://other.test/"};
    releaseSet();await pending;

    v.close(true);await (v as any).refreshFavorite();await (v as any).toggleFavorite();
  });

  it("covers GIF non-Error fallback, missing mount and warmup rejection",async()=>{
    const {v}=make({preloadNext:1,preloadPrevious:1});
    v.show(result([item(0,"gif")]));
    (v as any).gifModulePromise=Promise.resolve({GifPlayer:class{constructor(){throw "string boom"}},prepareGif:vi.fn(async()=>{})});
    await (v as any).mountGif(v.result!.items[0],(v as any).renderVersion);
    expect(v.panel.textContent).toContain("Native GIF playback");

    v.stage.innerHTML="";
    await (v as any).mountGif(v.result!.items[0],(v as any).renderVersion);

    (v as any).gifModulePromise=Promise.reject(new Error("warm failed"));
    await (v as any).warmGifNeighborhood();
    v.close(true);
  });

  it("covers active close-timer clearing and zero pointer gap positioning",()=>{
    const {v}=make({pointerGap:0});
    v.show(result([item(0)]));
    const clear=vi.spyOn(window,"clearTimeout");v.closeTimer=123;
    v.panel.dispatchEvent(new MouseEvent("mouseenter"));expect(clear).toHaveBeenCalledWith(123);
    (v as any).position(10,10);expect(v.panel.style.left).toBe("10px");
    v.close(true);
  });

  it("drags, resizes, clamps and remembers panel geometry",()=>{
    const {v}=make({draggablePanel:true,resizablePanel:true,rememberPanelGeometry:true});v.show(result([item(0)]));
    vi.spyOn(v.panel,"getBoundingClientRect").mockReturnValue({left:100,top:100,width:480,height:400,right:580,bottom:500,x:100,y:100,toJSON:()=>({})});
    const head=v.panel.querySelector(".lp-head")!;head.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,clientX:100,clientY:100}));window.dispatchEvent(new PointerEvent("pointermove",{clientX:150,clientY:130}));window.dispatchEvent(new PointerEvent("pointerup"));
    expect(store.viewerState.geometry).toMatchObject({left:150,top:130,width:480,height:400});
    const handle=v.panel.querySelector('[data-resize="se"]')!;handle.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,clientX:580,clientY:500}));window.dispatchEvent(new PointerEvent("pointermove",{clientX:680,clientY:580}));window.dispatchEvent(new PointerEvent("pointerup"));
    expect(store.viewerState.geometry.width).toBe(580);expect(store.viewerState.geometry.height).toBe(480);
    v.restoreViewerState({geometry:{left:-50,top:-50,width:5000,height:5000}});v.openLoading(10,10,v.settings,"Again");expect(parseFloat(v.panel.style.left)).toBeGreaterThanOrEqual(8);expect(parseFloat(v.panel.style.width)).toBeLessThanOrEqual(innerWidth-16);
    window.dispatchEvent(new Event("resize"));
    (v.panel.querySelector(".lp-title") as HTMLElement).dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));expect(store.viewerState.geometry).toBeUndefined();
    v.settings.rememberPanelGeometry=false;for(const placement of ["left","above","below","right"] as const){v.settings.placement=placement;(v as any).position(600,450)}
    (v.panel.querySelector(".lp-title") as HTMLElement).dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));
    v.settings.draggablePanel=false;head.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,clientX:100,clientY:100}));v.settings.draggablePanel=true;(v.panel.querySelector(".lp-close") as HTMLButtonElement).dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));
    v.closeTimer=99;const northWest=v.panel.querySelector('[data-resize="nw"]')!;northWest.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,clientX:100,clientY:100}));window.dispatchEvent(new PointerEvent("pointermove",{clientX:80,clientY:70}));v.error("reset bindings");v.panel.querySelector('[data-resize="s"]')!.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,clientX:100,clientY:100}));v.close(true);
  });

});
