import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../../src/shared/settings";

const gifMocks=vi.hoisted(()=>({
  parseGIF:vi.fn(),
  decompressFrames:vi.fn()
}));
vi.mock("gifuct-js",()=>gifMocks);

import {GifPlayer,clearPreparedGifCache,formatMediaTime,gifDuration,gifFrameDelay,gifTimeAtFrame,prepareGif} from "../../src/ui/gif-player";

const frame=(delay=50,disposalType=0,left=0,top=0,width=2,height=2)=>({
  dims:{left,top,width,height},patch:new Uint8ClampedArray(width*height*4).fill(255),delay,disposalType
});

describe("GIF runtime",()=>{
  let ctx:any,patchCtx:any,contexts:any[],send:any;
  beforeEach(()=>{
    vi.useFakeTimers();
    clearPreparedGifCache();
    contexts=[];
    ctx={
      clearRect:vi.fn(),getImageData:vi.fn(()=>({data:new Uint8ClampedArray(16),width:2,height:2})),
      putImageData:vi.fn(),drawImage:vi.fn()
    };
    patchCtx={clearRect:vi.fn(),getImageData:vi.fn(),putImageData:vi.fn(),drawImage:vi.fn()};
    vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockImplementation(function(){
      const value=contexts.length?patchCtx:ctx;contexts.push(value);return value as any;
    });
    class FakeImageData{data:Uint8ClampedArray;width:number;height:number;constructor(data:Uint8ClampedArray,width:number,height:number){this.data=data;this.width=width;this.height=height}}
    vi.stubGlobal("ImageData",FakeImageData as any);
    send=vi.fn(async()=>({base64:btoa("abc"),mime:"image/gif",bytes:3}));
    vi.stubGlobal("chrome",{runtime:{sendMessage:send}});
    gifMocks.parseGIF.mockReset();gifMocks.decompressFrames.mockReset();
    gifMocks.parseGIF.mockReturnValue({lsd:{width:10,height:8}});
    gifMocks.decompressFrames.mockReturnValue([frame(20),frame(30,2),frame(40,3)]);
    Object.defineProperty(document,"hidden",{configurable:true,value:false});
  });
  afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML=""});

  it("covers timeline helpers including negative values",()=>{
    expect(gifFrameDelay({delay:NaN})).toBe(100);
    expect(gifFrameDelay({delay:1})).toBe(20);
    expect(gifDuration([{delay:20},{delay:30}])).toBe(50);
    expect(gifTimeAtFrame([{delay:20}],-1)).toBe(0);
    expect(formatMediaTime(-2)).toBe("0:00.00");
  });

  it("prepares and caches GIFs, derives dimensions, evicts old cache entries and clears cache",async()=>{
    const a=await prepareGif("https://x/a.gif",32);expect(a.width).toBe(10);expect(a.height).toBe(8);
    await prepareGif("https://x/a.gif",32);expect(send).toHaveBeenCalledTimes(1);
    gifMocks.parseGIF.mockReturnValue({});
    gifMocks.decompressFrames.mockReturnValue([frame(20,0,3,4,5,6)]);
    const b=await prepareGif("https://x/b.gif",32);expect(b.width).toBe(8);expect(b.height).toBe(10);
    await prepareGif("https://x/c.gif",32);await prepareGif("https://x/d.gif",32);await prepareGif("https://x/e.gif",32);
    clearPreparedGifCache();await prepareGif("https://x/a.gif",32);expect(send.mock.calls.length).toBeGreaterThan(5);
  });

  it("rejects missing/error GIF data and empty decoded frames without poisoning the cache",async()=>{
    send.mockResolvedValueOnce({error:"bad"});await expect(prepareGif("https://x/bad.gif",1)).rejects.toThrow("bad");
    send.mockResolvedValueOnce({});await expect(prepareGif("https://x/missing.gif",1)).rejects.toThrow("GIF data unavailable");
    gifMocks.decompressFrames.mockReturnValueOnce([]);
    await expect(prepareGif("https://x/empty.gif",1)).rejects.toThrow("No GIF frames found");
  });

  it("initializes controls, composites transparent patches and handles disposal/re-render paths",async()=>{
    const stage=document.createElement("div");stage.innerHTML='<div class="lp-gif-mount"></div>';document.body.appendChild(stage);
    const p=new GifPlayer(stage,"https://x/a.gif",{...DEFAULT_SETTINGS,gifAutoplay:"never",gifScrubWheel:true},vi.fn());
    await p.init();
    expect(stage.querySelector("canvas")).toBeTruthy();
    expect(patchCtx.putImageData).toHaveBeenCalled();
    expect(ctx.drawImage).toHaveBeenCalled();

    (p as any).renderFrame(2);
    expect(ctx.clearRect).toHaveBeenCalled();
    (p as any).applyFrame(0);
    expect(ctx.putImageData).toHaveBeenCalled();
    (p as any).renderFrame(0);
    expect(ctx.clearRect).toHaveBeenCalled();

    const timeline=stage.querySelector(".lp-gif-timeline") as HTMLInputElement;
    timeline.value="2";timeline.dispatchEvent(new Event("input"));
    stage.querySelector<HTMLButtonElement>(".lp-gif-prev")!.click();
    stage.querySelector<HTMLButtonElement>(".lp-gif-next")!.click();
    stage.querySelector<HTMLButtonElement>(".lp-gif-toggle")!.click();
    stage.querySelector<HTMLButtonElement>(".lp-gif-loop")!.click();
    const speed=stage.querySelector(".lp-gif-speed") as HTMLSelectElement;speed.value="2";speed.dispatchEvent(new Event("change"));
    speed.value="";speed.dispatchEvent(new Event("change"));expect((p as any).speed).toBe(1);
    const wheel=new WheelEvent("wheel",{deltaX:10,deltaY:2,cancelable:true,bubbles:true});timeline.dispatchEvent(wheel);
    const wheelY=new WheelEvent("wheel",{deltaX:0,deltaY:-10,cancelable:true,bubbles:true});timeline.dispatchEvent(wheelY);
    stage.querySelector(".lp-gif-controls")!.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));
    p.destroy();
  });

  it("handles keys, playback scheduling, looping, speed limits and visibility pause/resume",async()=>{
    const stage=document.createElement("div");stage.innerHTML='<div class="lp-gif-mount"></div>';document.body.appendChild(stage);
    const p=new GifPlayer(stage,"https://x/a.gif",{...DEFAULT_SETTINGS,gifAutoplay:"never",gifLoop:false},vi.fn());
    expect(p.key(new KeyboardEvent("keydown",{key:" "}))).toBe(false);
    await p.init();
    expect(p.key(new KeyboardEvent("keydown",{key:" "}))).toBe(true);
    expect(p.key(new KeyboardEvent("keydown",{key:","}))).toBe(true);
    expect(p.key(new KeyboardEvent("keydown",{key:"."}))).toBe(true);
    expect(p.key(new KeyboardEvent("keydown",{key:"["}))).toBe(true);
    expect(p.key(new KeyboardEvent("keydown",{key:"]"}))).toBe(true);
    expect(p.key(new KeyboardEvent("keydown",{key:"x"}))).toBe(false);
    (p as any).settings.gifFrameStepKeyboard=false;expect(p.key(new KeyboardEvent("keydown",{key:","}))).toBe(false);
    (p as any).settings.gifFrameStepKeyboard=true;

    p.play();p.play();vi.advanceTimersByTime(1000);p.pause();p.toggle();p.toggle();
    (p as any).frame=2;(p as any).loop=false;p.play();vi.advanceTimersByTime(1000);
    (p as any).changeSpeed(-99);(p as any).changeSpeed(99);

    (p as any).playing=true;Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document,"hidden",{configurable:true,value:false});document.dispatchEvent(new Event("visibilitychange"));
    p.destroy();
  });

  it("covers default notice, destroyed-error and scheduler guard/end branches",async()=>{
    const makeStage=()=>{const s=document.createElement("div");s.innerHTML='<div class="lp-gif-mount"></div>';document.body.appendChild(s);return s};

    clearPreparedGifCache();send.mockRejectedValueOnce(new Error("default notice"));
    const noNotice=new GifPlayer(makeStage(),"https://x/default-notice.gif",{...DEFAULT_SETTINGS,gifAutoplay:"never"});
    await noNotice.init();expect(document.body.textContent).toContain("frame controls unavailable");

    clearPreparedGifCache();let rejectSlow!:(e:any)=>void;send.mockImplementationOnce(()=>new Promise((_r,reject)=>{rejectSlow=reject}));
    const destroyed=new GifPlayer(makeStage(),"https://x/destroy-error.gif",{...DEFAULT_SETTINGS,gifAutoplay:"never"},vi.fn());
    const pending=destroyed.init();destroyed.destroy();rejectSlow(new Error("late fail"));await pending;
    expect((destroyed as any).frames).toHaveLength(0);

    clearPreparedGifCache();send.mockResolvedValue({base64:btoa("abc"),mime:"image/gif",bytes:3});
    const p=new GifPlayer(makeStage(),"https://x/schedule.gif",{...DEFAULT_SETTINGS,gifAutoplay:"never",gifLoop:true},vi.fn());
    await p.init();

    (p as any).speedSelect=undefined;(p as any).playing=false;(p as any).changeSpeed(1);
    (p as any).schedule();
    (p as any).playing=true;(p as any).destroyed=true;(p as any).schedule();
    (p as any).destroyed=false;(p as any).playing=true;(p as any).frame=0;(p as any).schedule();
    (p as any).playing=false;vi.advanceTimersByTime(1000);

    (p as any).playing=true;(p as any).loop=true;(p as any).frame=(p as any).frames.length-1;(p as any).schedule();vi.advanceTimersToNextTimer();
    expect((p as any).frame).toBe(0);

    (p as any).playing=true;(p as any).loop=false;(p as any).frame=(p as any).frames.length-1;(p as any).schedule();vi.advanceTimersToNextTimer();
    expect((p as any).playing).toBe(false);
    p.destroy();
  });

  it("supports autoplay, no-wheel controls, fallback errors, destroyed init and missing canvas",async()=>{
    const makeStage=()=>{const s=document.createElement("div");s.innerHTML='<div class="lp-gif-mount"></div>';document.body.appendChild(s);return s};
    let s=makeStage(),notice=vi.fn();
    const auto=new GifPlayer(s,"https://x/a.gif",{...DEFAULT_SETTINGS,gifAutoplay:"focus",gifPauseWhenHidden:false,gifScrubWheel:false},notice);
    await auto.init();expect((auto as any).playing).toBe(true);auto.destroy();

    clearPreparedGifCache();send.mockResolvedValueOnce({error:"too big"});s=makeStage();const bad=new GifPlayer(s,"https://x/'bad.gif",DEFAULT_SETTINGS,notice);
    await bad.init();expect(s.textContent).toContain("frame controls unavailable");expect(notice).toHaveBeenCalledWith("too big");

    clearPreparedGifCache();let resolve!:Function;send.mockImplementationOnce(()=>new Promise(r=>{resolve=r}));s=makeStage();const destroyed=new GifPlayer(s,"https://x/slow.gif",DEFAULT_SETTINGS,notice);
    const pending=destroyed.init();destroyed.destroy();resolve({base64:btoa("abc")});await pending;expect((destroyed as any).frames).toHaveLength(0);

    clearPreparedGifCache();contexts=[];vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(null);
    s=makeStage();const noCanvas=new GifPlayer(s,"https://x/nocanvas.gif",{...DEFAULT_SETTINGS,gifAutoplay:"never"},notice);
    await noCanvas.init();expect(s.textContent).toContain("frame controls unavailable");
  });

  it("covers internal no-context/no-patch guards",async()=>{
    const stage=document.createElement("div");stage.innerHTML='<div class="lp-gif-mount"></div>';document.body.appendChild(stage);
    const p=new GifPlayer(stage,"https://x/a.gif",{...DEFAULT_SETTINGS,gifAutoplay:"never"},vi.fn());await p.init();
    (p as any).ctx=undefined;(p as any).renderFrame(0);(p as any).applyFrame(0);
    (p as any).ctx=ctx;(p as any).canvas=undefined;(p as any).applyFrame(0);
    (p as any).canvas=document.createElement("canvas");(p as any).patchCanvas=undefined;(p as any).applyFrame(0);
    p.destroy();
  });
});
