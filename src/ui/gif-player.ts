import {decompressFrames,parseGIF} from "gifuct-js";
import type {LinkPeekSettings} from "../shared/settings";

type DecodedFrame={
  dims:{top:number;left:number;width:number;height:number};
  patch:Uint8ClampedArray;delay:number;disposalType:number;
};
type BinaryResponse={base64?:string;mime?:string;bytes?:number;error?:string};

export function gifFrameDelay(frame:Pick<DecodedFrame,"delay">){return Math.max(20,Number(frame.delay)||100)}
export function gifDuration(frames:Pick<DecodedFrame,"delay">[]){return frames.reduce((n,f)=>n+gifFrameDelay(f),0)}
export function gifTimeAtFrame(frames:Pick<DecodedFrame,"delay">[],index:number){
  return frames.slice(0,Math.max(0,index)).reduce((n,f)=>n+gifFrameDelay(f),0);
}
export function formatMediaTime(ms:number){
  const total=Math.max(0,ms)/1000,minutes=Math.floor(total/60),seconds=Math.floor(total%60),hundredths=Math.floor((total%1)*100);
  return `${minutes}:${String(seconds).padStart(2,"0")}.${String(hundredths).padStart(2,"0")}`;
}
function decodeBase64(value:string){
  const binary=atob(value),bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return bytes;
}

export class GifPlayer{
  private mount:HTMLElement;private canvas?:HTMLCanvasElement;private ctx?:CanvasRenderingContext2D;
  private frames:DecodedFrame[]=[];private frame=0;private rendered=-1;private restoreBeforePrevious:ImageData|null=null;
  private playing=false;private loop=true;private speed=1;private timer?:number;private destroyed=false;private resumeAfterVisibility=false;
  private timeline?:HTMLInputElement;private toggleButton?:HTMLButtonElement;private loopButton?:HTMLButtonElement;private speedSelect?:HTMLSelectElement;private timeLabel?:HTMLElement;
  constructor(private stage:HTMLElement,private url:string,private settings:LinkPeekSettings,private onNotice:(message:string)=>void=()=>{}){
    this.mount=stage.querySelector(".lp-gif-mount") as HTMLElement;
    this.loop=settings.gifLoop;this.speed=settings.gifDefaultSpeed;
  }
  async init(){
    this.mount.innerHTML='<div class="lp-gif-preparing"><span class="lp-loading-dot"></span><span>Preparing GIF frame controls…</span></div>';
    try{
      const response=await chrome.runtime.sendMessage({type:"LINKPEEK_FETCH_BINARY",url:this.url,maxMb:this.settings.gifDecodeMaxMb}) as BinaryResponse;
      if(response?.error||!response?.base64)throw new Error(response?.error||"GIF data unavailable");
      if(this.destroyed)return;
      const parsed=parseGIF(decodeBase64(response.base64).buffer) as any;
      this.frames=decompressFrames(parsed,true) as DecodedFrame[];
      if(!this.frames.length)throw new Error("No GIF frames found");
      const width=Number(parsed?.lsd?.width)||Math.max(...this.frames.map(f=>f.dims.left+f.dims.width));
      const height=Number(parsed?.lsd?.height)||Math.max(...this.frames.map(f=>f.dims.top+f.dims.height));
      this.build(width,height);
      this.renderFrame(0);this.updateControls();
      if(this.settings.gifAutoplay!=="never")this.play();
      if(this.settings.gifPauseWhenHidden)document.addEventListener("visibilitychange",this.onVisibility);
    }catch(error){
      if(!this.destroyed)this.fallback(error instanceof Error?error.message:String(error));
    }
  }
  destroy(){
    this.destroyed=true;this.pause();document.removeEventListener("visibilitychange",this.onVisibility);
  }
  key(e:KeyboardEvent){
    if(!this.frames.length)return false;
    if(e.key===" "){this.toggle();return true}
    if(!this.settings.gifFrameStepKeyboard)return false;
    if(e.key===","){this.step(-1);return true}
    if(e.key==="."){this.step(1);return true}
    if(e.key==="["){this.changeSpeed(-1);return true}
    if(e.key==="]"){this.changeSpeed(1);return true}
    return false;
  }
  play(){
    if(!this.frames.length||this.playing)return;
    if(this.frame>=this.frames.length-1&&!this.loop)this.goto(0);
    this.playing=true;this.updateControls();this.schedule();
  }
  pause(){
    this.playing=false;if(this.timer)window.clearTimeout(this.timer);this.timer=undefined;this.updateControls();
  }
  toggle(){this.playing?this.pause():this.play()}
  step(delta:number){this.pause();this.goto(Math.max(0,Math.min(this.frames.length-1,this.frame+delta)))}
  private build(width:number,height:number){
    this.mount.innerHTML=`<div class="lp-gif-player" data-controls="${this.settings.gifControls}">
      <div class="lp-gif-surface"><canvas class="lp-image lp-gif-canvas" aria-label="Animated GIF frame"></canvas></div>
      <div class="lp-gif-controls" role="group" aria-label="GIF playback controls">
        <button class="lp-media-btn lp-gif-prev" type="button" aria-label="Previous GIF frame" title="Previous frame (,)">│‹</button>
        <button class="lp-media-btn lp-gif-toggle" type="button" aria-label="Pause GIF" title="Play / pause (Space)">Ⅱ</button>
        <button class="lp-media-btn lp-gif-next" type="button" aria-label="Next GIF frame" title="Next frame (.)">›│</button>
        <input class="lp-gif-timeline" type="range" min="0" max="${this.frames.length-1}" step="1" value="0" aria-label="GIF timeline">
        <span class="lp-gif-time" aria-live="off"></span>
        <select class="lp-gif-speed" aria-label="GIF playback speed" title="Playback speed">
          ${[.25,.5,.75,1,1.5,2,4].map(v=>`<option value="${v}" ${v===this.speed?"selected":""}>${v}×</option>`).join("")}
        </select>
        <button class="lp-media-btn lp-gif-loop" type="button" aria-label="Toggle GIF loop" aria-pressed="${this.loop}" title="Loop">↻</button>
      </div>
    </div>`;
    this.canvas=this.mount.querySelector(".lp-gif-canvas") as HTMLCanvasElement;this.canvas.width=width;this.canvas.height=height;
    this.ctx=this.canvas.getContext("2d",{willReadFrequently:true})||undefined;
    if(!this.ctx)throw new Error("Canvas unavailable");
    this.timeline=this.mount.querySelector(".lp-gif-timeline") as HTMLInputElement;
    this.toggleButton=this.mount.querySelector(".lp-gif-toggle") as HTMLButtonElement;
    this.loopButton=this.mount.querySelector(".lp-gif-loop") as HTMLButtonElement;
    this.speedSelect=this.mount.querySelector(".lp-gif-speed") as HTMLSelectElement;
    this.timeLabel=this.mount.querySelector(".lp-gif-time") as HTMLElement;
    this.mount.querySelector(".lp-gif-prev")?.addEventListener("click",()=>this.step(-1));
    this.mount.querySelector(".lp-gif-next")?.addEventListener("click",()=>this.step(1));
    this.toggleButton.addEventListener("click",()=>this.toggle());
    this.loopButton.addEventListener("click",()=>{this.loop=!this.loop;this.updateControls()});
    this.speedSelect.addEventListener("change",()=>{this.speed=Number(this.speedSelect!.value)||1;if(this.playing)this.schedule();this.updateControls()});
    this.timeline.addEventListener("input",()=>{const was=this.playing;this.pause();this.goto(Number(this.timeline!.value));if(was)this.play()});
    if(this.settings.gifScrubWheel)this.timeline.addEventListener("wheel",this.onTimelineWheel,{passive:false});
    this.mount.querySelector(".lp-gif-controls")?.addEventListener("dblclick",e=>e.stopPropagation());
  }
  private fallback(reason:string){
    this.mount.innerHTML=`<div class="lp-gif-fallback"><img class="lp-image" src="${this.escape(this.url)}" alt="Animated GIF"><span>Native GIF playback · frame controls unavailable</span></div>`;
    this.onNotice(reason);
  }
  private onTimelineWheel=(e:WheelEvent)=>{
    e.preventDefault();e.stopPropagation();const delta=Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.deltaY;if(delta)this.step(delta>0?1:-1);
  };
  private onVisibility=()=>{
    if(document.hidden){this.resumeAfterVisibility=this.playing;if(this.playing)this.pause()}
    else if(this.resumeAfterVisibility){this.resumeAfterVisibility=false;this.play()}
  };
  private changeSpeed(direction:number){
    const speeds=[.25,.5,.75,1,1.5,2,4],at=speeds.reduce((best,v,i)=>Math.abs(v-this.speed)<Math.abs(speeds[best]-this.speed)?i:best,0);
    this.speed=speeds[Math.max(0,Math.min(speeds.length-1,at+direction))];if(this.speedSelect)this.speedSelect.value=String(this.speed);if(this.playing)this.schedule();this.updateControls();
  }
  private schedule(){
    if(this.timer)window.clearTimeout(this.timer);if(!this.playing||this.destroyed)return;
    const delay=gifFrameDelay(this.frames[this.frame])/Math.max(.1,this.speed);
    this.timer=window.setTimeout(()=>{
      if(!this.playing)return;
      if(this.frame>=this.frames.length-1){if(this.loop)this.goto(0);else{this.pause();return}}
      else this.goto(this.frame+1);
      this.schedule();
    },delay);
  }
  private goto(index:number){
    this.frame=Math.max(0,Math.min(this.frames.length-1,index));this.renderFrame(this.frame);this.updateControls();
  }
  private renderFrame(target:number){
    if(!this.ctx)return;
    if(target!==this.rendered+1){this.ctx.clearRect(0,0,this.canvas!.width,this.canvas!.height);this.rendered=-1;this.restoreBeforePrevious=null}
    for(let i=this.rendered+1;i<=target;i++)this.applyFrame(i);
  }
  private applyFrame(index:number){
    if(!this.ctx||!this.canvas)return;
    if(this.rendered>=0){
      const prev=this.frames[this.rendered];
      if(prev.disposalType===2)this.ctx.clearRect(prev.dims.left,prev.dims.top,prev.dims.width,prev.dims.height);
      else if(prev.disposalType===3&&this.restoreBeforePrevious)this.ctx.putImageData(this.restoreBeforePrevious,0,0);
    }
    const frame=this.frames[index];
    this.restoreBeforePrevious=frame.disposalType===3?this.ctx.getImageData(0,0,this.canvas.width,this.canvas.height):null;
    this.ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.patch),frame.dims.width,frame.dims.height),frame.dims.left,frame.dims.top);
    this.rendered=index;
  }
  private updateControls(){
    if(!this.frames.length)return;
    if(this.toggleButton){this.toggleButton.textContent=this.playing?"Ⅱ":"▶";this.toggleButton.setAttribute("aria-label",this.playing?"Pause GIF":"Play GIF")}
    if(this.loopButton)this.loopButton.setAttribute("aria-pressed",String(this.loop));
    if(this.timeline)this.timeline.value=String(this.frame);
    if(this.speedSelect)this.speedSelect.value=String(this.speed);
    if(this.timeLabel)this.timeLabel.textContent=`${formatMediaTime(gifTimeAtFrame(this.frames,this.frame))} / ${formatMediaTime(gifDuration(this.frames))} · F ${this.frame+1}/${this.frames.length}`;
  }
  private escape(v:string){return v.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!))}
}
