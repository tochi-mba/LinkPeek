import type {MediaItem,ScanResult} from "../shared/media";
import type {LinkPeekSettings} from "../shared/settings";
import {overlayCss} from "./styles";
import {GestureController} from "./gesture";
import {GifPlayer} from "./gif-player";

export class Viewer{
  host=document.createElement("div");shadow=this.host.attachShadow({mode:"open"});root=document.createElement("div");
  panel=document.createElement("section");stage=document.createElement("div");settings!:LinkPeekSettings;result?:ScanResult;
  index=0;zoom=1;tx=0;ty=0;pinned=false;view:"focus"|"grid"="focus";gesture?:GestureController;gifPlayer?:GifPlayer;closeTimer?:number;help=false;
  onDismiss?:()=>void;
  constructor(){this.root.className="lp-root";this.shadow.append(Object.assign(document.createElement("style"),{textContent:overlayCss}),this.root);document.documentElement.appendChild(this.host)}
  openLoading(x:number,y:number,settings:LinkPeekSettings,title="Scanning link…"){this.settings=settings;this.panel.className="lp-panel";this.position(x,y);this.panel.innerHTML=this.shell(title,`<div class="lp-loading"><span class="lp-loading-dot"></span><span>Finding posted media…</span></div>`,"Scanning…");this.root.replaceChildren(this.panel);this.bind()}
  show(result:ScanResult){this.result=result;this.index=Math.min(this.index,Math.max(0,result.items.length-1));this.render()}
  error(message:string){this.panel.innerHTML=this.shell("Couldn’t preview",`<div class="lp-error"><strong>Preview unavailable</strong><span>${this.escape(message)}</span></div>`,"");this.bind()}
  close(force=false){if(this.pinned&&!force)return;this.gifPlayer?.destroy();this.gifPlayer=undefined;this.root.replaceChildren();this.result=undefined;this.gesture?.destroy();this.onDismiss?.()}
  private render(){
    if(!this.result)return;this.gifPlayer?.destroy();this.gifPlayer=undefined;const item=this.result.items[this.index];const media=item?.type==="gif"?`<div class="lp-gif-mount"></div>`:`<img class="lp-image" src="${item?this.escape(item.previewUrl):""}" alt="${item?this.escape(item.filename||"Preview image"):""}">`;const tip=item?.type==="gif"?"Space play/pause · ,/. frame step · ? for help":"↕ scroll · pinch to zoom · ? for help";const body=this.view==="grid"?this.grid():item?`<div class="lp-stage">${media}${this.settings.showLearningTips?`<div class="lp-tip">${tip}</div>`:""}</div>`:'<div class="lp-empty">No posted media found.</div>';
    const progress=this.result.complete?"Complete":`${this.result.postsScanned??0}/${this.result.totalPosts??"?"} posts`;
    this.panel.innerHTML=this.shell(this.result.title||new URL(this.result.url).hostname,body,`${this.result.items.length} media · ${progress}`);
    this.bind();
    if(this.view==="focus"&&item){this.stage=this.panel.querySelector(".lp-stage") as HTMLDivElement;this.gesture?.destroy();this.gesture=new GestureController(this.stage,{
      next:(n?:number)=>this.move(n||1),
      previous:(n?:number)=>this.move(-(n||1)),
      scrub:(d:number)=>this.move(d>0?this.settings.maxImagesPerSwipe:-this.settings.maxImagesPerSwipe),
      pan:(dx:number,dy:number)=>this.pan(dx,dy),
      zoom:(factor:number,x:number,y:number)=>this.applyZoom(factor,x,y),
      doubleClick:(x:number,y:number)=>this.onDoubleClick(x,y),
      isZoomed:()=>this.zoom>1.01
    },this.settings);if(item.type==="gif"){this.gifPlayer=new GifPlayer(this.stage,item.originalUrl,this.settings,message=>this.toast(message));void this.gifPlayer.init()}}
  }
  private shell(title:string,body:string,status:string){return `<header class="lp-head"><span class="lp-brand">REX · LINKPEEK</span><span class="lp-title">${this.escape(title)}</span><span class="lp-meta">${this.result?.items.length??""}</span><button class="lp-btn lp-gridbtn" title="Grid (G)">▦</button><button class="lp-btn lp-helpbtn" title="Controls (?)">?</button><button class="lp-btn lp-pin" aria-pressed="${this.pinned}" title="Pin (P)">⌖</button><button class="lp-btn lp-close" title="Close">×</button></header>${body}<footer class="lp-foot"><span class="lp-count">${this.result?.items.length?this.index+1:0} / ${this.result?.items.length??0}</span><span>${this.result?.items[this.index]?.postNumber?`Post #${this.result.items[this.index].postNumber}`:""}</span><span class="lp-spacer"></span><span class="lp-signal">${this.escape(status)}</span></footer>${this.help?this.helpMarkup():""}`;}
  private grid(){return `<div class="lp-grid">${this.result!.items.map((i,n)=>`<button class="lp-thumb" data-i="${n}" aria-current="${n===this.index}"><img src="${this.escape(i.previewUrl)}" alt=""></button>`).join("")}</div>`}
  private helpMarkup(){const gif=this.result?.items[this.index]?.type==="gif"?`<kbd>Space</kbd><span>GIF play / pause</span><kbd>, / .</kbd><span>Previous / next GIF frame</span><kbd>[ / ]</kbd><span>GIF slower / faster</span><kbd>timeline scroll</kbd><span>Scrub GIF frames</span>`:"";return `<div class="lp-help"><h3>One-hand controls</h3><div class="lp-help-grid"><kbd>↕ two-finger</kbd><span>Previous / next media</span><kbd>↔ two-finger</kbd><span>Fast scrub</span><kbd>pinch</kbd><span>Zoom</span><kbd>double click</kbd><span>Zoom at pointer / reset</span>${gif}<kbd>G</kbd><span>Grid / focus</span><kbd>P</kbd><span>Pin panel</span><kbd>O</kbd><span>Open original</span><kbd>D</kbd><span>Download original</span><kbd>Esc</kbd><span>Close</span></div></div>`}
  private bind(){
    this.panel.querySelector(".lp-close")?.addEventListener("click",()=>this.close(true));
    this.panel.querySelector(".lp-pin")?.addEventListener("click",()=>{this.pinned=!this.pinned;this.render()});
    this.panel.querySelector(".lp-gridbtn")?.addEventListener("click",()=>{this.view=this.view==="grid"?"focus":"grid";this.render()});
    this.panel.querySelector(".lp-helpbtn")?.addEventListener("click",()=>{this.help=!this.help;this.render()});
    this.panel.querySelectorAll(".lp-thumb").forEach(el=>el.addEventListener("click",()=>{this.index=Number((el as HTMLElement).dataset.i);this.view="focus";this.render()}));
    this.panel.addEventListener("mouseenter",()=>{if(this.closeTimer)clearTimeout(this.closeTimer)});
    this.panel.addEventListener("mouseleave",()=>{if(!this.pinned)this.closeTimer=window.setTimeout(()=>this.close(),this.settings.closeDelay)});
  }
  key(e:KeyboardEvent){
    if(!this.root.childElementCount)return false;
    if(this.gifPlayer?.key(e))return true;
    const hit=(action:string,fallback:string[]=[])=>[...(this.settings.shortcuts[action]??[]),...fallback].some(k=>k.toLowerCase()===e.key.toLowerCase());
    if(hit("close",["Escape"])){this.close(true);return true}
    if(hit("grid",["g"])){this.view=this.view==="grid"?"focus":"grid";this.render();return true}
    if(hit("pin",["p"])){this.pinned=!this.pinned;this.render();return true}
    if(hit("help",["?","/"])){this.help=!this.help;this.render();return true}
    if(hit("next",["ArrowDown","ArrowRight"," "])){this.move(1);return true}
    if(hit("previous",["ArrowUp","ArrowLeft"])){this.move(-1);return true}
    if(hit("open",["o"])){const i=this.result?.items[this.index];if(i)window.open(i.originalUrl,"_blank","noopener");return true}
    if(hit("download",["d"])){const i=this.result?.items[this.index];if(i)chrome.runtime.sendMessage({type:"LINKPEEK_DOWNLOAD",url:i.originalUrl,filename:i.filename});return true}
    if(hit("resetZoom",["0"])){this.zoom=1;this.tx=this.ty=0;this.paintTransform();return true}
    if(hit("zoomIn",["+","="])){this.applyZoom(1.2,this.stage.clientWidth/2,this.stage.clientHeight/2);return true}
    if(hit("zoomOut",["-"])){this.applyZoom(1/1.2,this.stage.clientWidth/2,this.stage.clientHeight/2);return true}
    return false;
  }
  move(delta:number){if(!this.result?.items.length)return;const max=this.result.items.length-1;let n=this.index+delta;if(this.settings.loopMode==="wrap")n=(n+this.result.items.length)%this.result.items.length;else n=Math.max(0,Math.min(max,n));if(n!==this.index){this.index=n;if(this.settings.resetZoomPerImage){this.zoom=1;this.tx=this.ty=0}this.render()}}
  quickZoom(x:number,y:number){
    if(this.zoom>1.01&&this.settings.secondDoubleClick==="fit"){this.zoom=1;this.tx=this.ty=0;this.paintTransform();this.toast("Fit");return}
    const target=Math.max(1,this.settings.doubleClickZoom);this.applyZoom(target/this.zoom,x,y)
  }
  applyZoom(factor:number,x:number,y:number){const old=this.zoom;this.zoom=Math.max(this.settings.minZoom,Math.min(this.settings.maxZoom,this.zoom*factor));if(old===this.zoom&&factor>1&&old>1){this.zoom=1;this.tx=this.ty=0}else{const ratio=this.zoom/old;this.tx=x-(x-this.tx)*ratio;this.ty=y-(y-this.ty)*ratio}this.paintTransform();this.toast(`${Math.round(this.zoom*100)}%`)}
  pan(dx:number,dy:number){if(this.zoom<=1&&this.settings.verticalGesture!=="pan")return;this.tx+=dx;this.ty+=dy;this.paintTransform()}
  onDoubleClick(x:number,y:number){
    if(this.settings.doubleClick==="next"){this.move(1);return}
    if(this.settings.doubleClick==="fullscreen"){
      if(document.fullscreenElement)void document.exitFullscreen();else void this.panel.requestFullscreen?.();return;
    }
    if(this.zoom>1&&this.settings.secondDoubleClick==="fit"){this.zoom=1;this.tx=this.ty=0;this.paintTransform();this.toast("Fit");return}
    this.applyZoom(this.settings.doubleClickZoom,x,y);
  }
  paintTransform(){const img=this.panel.querySelector(".lp-image") as HTMLElement|null;if(img)img.style.transform=`translate(${this.tx}px,${this.ty}px) scale(${this.zoom})`}
  toast(text:string){const t=document.createElement("div");t.className="lp-toast";t.textContent=text;this.panel.appendChild(t);setTimeout(()=>t.remove(),650)}
  position(x:number,y:number){const w=this.settings.panelWidth||480,h=480,g=this.settings.pointerGap||12;let left=x+g,top=y+g;if(left+w>innerWidth-12)left=Math.max(12,x-w-g);if(top+h>innerHeight-12)top=Math.max(12,y-h-g);this.panel.style.left=`${left}px`;this.panel.style.top=`${top}px`;this.panel.style.setProperty("--lp-width",`${w}px`);this.panel.style.setProperty("--lp-maxh",`${this.settings.panelMaxVh}vh`);this.panel.style.setProperty("--lp-thumb",`${this.settings.thumbnailSize}px`);this.panel.style.opacity=String(this.settings.panelOpacity);this.panel.style.background=`rgba(17,21,18,${Math.max(.1,1-this.settings.transparency)})`;this.panel.style.backdropFilter=`blur(${this.settings.blur}px)`;if(this.settings.motion==="none"||this.settings.reducedMotion)this.panel.style.animation="none"}
  private escape(v:string){return v.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!))}
}
