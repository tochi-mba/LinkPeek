import type {MediaItem,ScanResult} from "../shared/media";
import {uniqueMediaItems} from "../shared/media";
import type {LinkPeekSettings} from "../shared/settings";
import {overlayCss} from "./styles";
import {GestureController} from "./gesture";
import {MediaPreloader} from "./media-preloader";
import {isFavorite,toggleFavorite} from "../shared/favorites";

type GifPlayerLike={init:()=>Promise<void>;destroy:()=>void;key:(e:KeyboardEvent)=>boolean};
type GifModule={
  GifPlayer:new(stage:HTMLElement,url:string,settings:LinkPeekSettings,onNotice?:(message:string)=>void)=>GifPlayerLike;
  prepareGif:(url:string,maxMb:number)=>Promise<unknown>;
};

export class Viewer{
  host=document.createElement("div");shadow=this.host.attachShadow({mode:"open"});root=document.createElement("div");
  panel=document.createElement("section");stage=document.createElement("div");settings!:LinkPeekSettings;result?:ScanResult;
  index=0;zoom=1;tx=0;ty=0;pinned=false;view:"focus"|"grid"="focus";gesture?:GestureController;gifPlayer?:GifPlayerLike;closeTimer?:number;help=false;
  onDismiss?:()=>void;private gridCleanup?:()=>void;private renderVersion=0;private preloader=new MediaPreloader();private navigationVersion=0;private desiredIndex:number|null=null;private expanded=false;private gridThumbSize=120;private gridScrollTop=0;private rememberedView?:"focus"|"grid";private rememberedGridThumbSize?:number;private rememberedExpanded?:boolean;private gifModulePromise?:Promise<GifModule>;private favorite=false;private favoriteVersion=0;
  get isOpen(){return this.root.childElementCount>0}
  containsPoint(x:number,y:number,from?:DOMRect){
    if(!this.isOpen)return false;
    const panel=this.panel.getBoundingClientRect(),pad=Math.max(8,Math.round(this.settings.magneticBridgeStrength*20));
    if(x>=panel.left-pad&&x<=panel.right+pad&&y>=panel.top-pad&&y<=panel.bottom+pad)return true;
    if(!from||!this.settings?.magneticBridge)return false;
    const left=Math.min(from.left,panel.left)-pad,right=Math.max(from.right,panel.right)+pad,top=Math.min(from.top,panel.top)-pad,bottom=Math.max(from.bottom,panel.bottom)+pad;
    return x>=left&&x<=right&&y>=top&&y<=bottom;
  }
  constructor(){this.root.className="lp-root";this.shadow.append(Object.assign(document.createElement("style"),{textContent:overlayCss}),this.root);document.documentElement.appendChild(this.host)}
  restoreViewerState(state?:{view?:"focus"|"grid";gridThumbSize?:number;expanded?:boolean}){
    if(state?.view==="focus"||state?.view==="grid")this.rememberedView=state.view;
    if(Number.isFinite(state?.gridThumbSize))this.rememberedGridThumbSize=Math.max(48,Math.min(320,Number(state!.gridThumbSize)));
    if(typeof state?.expanded==="boolean")this.rememberedExpanded=state.expanded;
  }
  private persistViewerState(){
    this.rememberedView=this.view;this.rememberedGridThumbSize=this.gridThumbSize;this.rememberedExpanded=this.expanded;
    void chrome.storage.local.set({viewerState:{view:this.view,gridThumbSize:this.gridThumbSize,expanded:this.expanded}});
  }
  private toggleView(){this.view=this.view==="grid"?"focus":"grid";this.persistViewerState();this.render()}
  openLoading(x:number,y:number,settings:LinkPeekSettings,title="Scanning link…"){this.settings=settings;this.result=undefined;this.index=0;this.zoom=1;this.tx=this.ty=0;this.gridScrollTop=0;this.expanded=this.rememberedExpanded??settings.startExpanded;this.gridThumbSize=this.rememberedGridThumbSize??settings.thumbnailSize;this.view=this.rememberedView??(settings.defaultView==="grid"||settings.defaultView==="masonry"?"grid":"focus");this.panel.className=`lp-panel${this.expanded?" lp-expanded":""}`;this.position(x,y);this.panel.innerHTML=this.shell(title,`<div class="lp-loading"><span class="lp-loading-dot"></span><span>Preparing media…</span></div>`,"Loading");this.root.replaceChildren(this.panel);this.bind()}
  show(result:ScanResult){
    const same=this.result?.url===result.url?this.result:undefined;
    const currentId=same?.items[this.index]?.id;if(!same)this.gridScrollTop=0;
    const merged=uniqueMediaItems(same?[...same.items,...result.items]:result.items);
    const diagnostics=result.diagnostics?{...result.diagnostics,duplicates:Math.max(same?.diagnostics?.duplicates??0,result.diagnostics.duplicates)}:same?.diagnostics;
    this.result={
      ...same,...result,
      items:merged.items,
      complete:Boolean(same?.complete||result.complete),
      postsScanned:Math.max(same?.postsScanned??0,result.postsScanned??0)||undefined,
      totalPosts:Math.max(same?.totalPosts??0,result.totalPosts??0)||undefined,
      diagnostics
    };
    this.index=Math.min(this.index,Math.max(0,this.result.items.length-1));
    const progressed=Boolean(same&&(result.items.length!==same.items.length||result.postsScanned!==same.postsScanned||result.complete!==same.complete));
    const canPreserve=Boolean(same&&!same.complete&&progressed&&this.view==="focus"&&currentId&&this.result.items[this.index]?.id===currentId&&this.panel.querySelector(".lp-stage"));
    if(canPreserve){
      this.preloader.reset(this.result.items,this.index,this.settings);
      this.panel.querySelector<HTMLElement>(".lp-meta")!.textContent=String(this.result.items.length);
      this.panel.querySelector<HTMLElement>(".lp-count")!.textContent=`${this.index+1} / ${this.result.items.length}`;
      this.panel.querySelector<HTMLElement>(".lp-signal")!.textContent=`${this.result.items.length} media · ${this.result.complete?"Complete":`${this.result.postsScanned??0}/${this.result.totalPosts??"?"} posts`}`;
    }else this.render();
    void this.refreshFavorite()
  }
  error(message:string){this.panel.innerHTML=this.shell("Couldn’t preview",`<div class="lp-error"><strong>Preview unavailable</strong><span>${this.escape(message)}</span></div>`,"");this.bind()}
  close(force=false){if(this.pinned&&!force)return;if(force)this.pinned=false;this.renderVersion++;this.navigationVersion++;this.desiredIndex=null;this.gridCleanup?.();this.gridCleanup=undefined;this.gifPlayer?.destroy();this.gifPlayer=undefined;this.preloader.dispose();this.root.replaceChildren();this.result=undefined;this.gesture?.destroy();this.onDismiss?.()}
  private render(){
    if(!this.result)return;
    const version=++this.renderVersion;
    this.panel.className=`lp-panel${this.expanded?" lp-expanded":""}`;
    this.gridCleanup?.();this.gridCleanup=undefined;this.gifPlayer?.destroy();this.gifPlayer=undefined;
    const item=this.result.items[this.index];
    const hasDecoded=item&&item.type!=="gif"&&this.preloader.isReady(item);
    const media=item?.type==="gif"?`<div class="lp-gif-mount"></div>`:hasDecoded?`<div class="lp-image-slot"></div>`:`<img class="lp-image" src="${item?this.escape(item.previewUrl):""}" alt="${item?this.escape(item.filename||"Preview image"):""}">`;
    const tip=item?.type==="gif"?"Scroll to browse · Space to pause":"Scroll to browse · Pinch to zoom";
    const body=this.view==="grid"?this.grid():item?`<div class="lp-stage">${media}${this.settings.showLearningTips?`<div class="lp-tip">${tip}</div>`:""}</div>`:'<div class="lp-empty">No posted media found.</div>';
    const progress=this.result.complete?"Complete":`${this.result.postsScanned??0}/${this.result.totalPosts??"?"} posts`;
    this.panel.innerHTML=this.shell(this.result.title||new URL(this.result.url).hostname,body,`${this.result.items.length} media · ${progress}`);
    this.bind();
    this.preloader.reset(this.result.items,this.index,this.settings);
    if(this.view==="grid"){this.setupVirtualGrid();return}
    void this.warmGifNeighborhood();
    if(item){
      this.stage=this.panel.querySelector(".lp-stage") as HTMLDivElement;this.gesture?.destroy();this.gesture=new GestureController(this.stage,{
        next:(n?:number)=>this.move(n||1),previous:(n?:number)=>this.move(-(n||1)),
        scrub:(d:number)=>this.move(d>0?this.settings.maxImagesPerSwipe:-this.settings.maxImagesPerSwipe),
        pan:(dx:number,dy:number)=>this.pan(dx,dy),zoom:(factor:number,x:number,y:number)=>this.applyZoom(factor,x,y),
        doubleClick:(x:number,y:number)=>this.onDoubleClick(x,y),isZoomed:()=>this.zoom>1.01
      },this.settings);
      if(item.type==="gif")void this.mountGif(item,version);
      else if(hasDecoded){
        const decoded=this.preloader.element(item);if(decoded){const slot=this.stage.querySelector(".lp-image-slot")!;decoded.className="lp-image";decoded.alt=item.filename||"Preview image";slot.replaceWith(decoded)}
      }
    }
  }
  private loadGifModule(){return this.gifModulePromise??=import(chrome.runtime.getURL("gif-player.js")) as Promise<GifModule>}
  private async warmGifNeighborhood(){
    if(!this.result?.items.length)return;
    const items=this.result.items,length=items.length,seen=new Set<number>(),indexes:number[]=[];
    const add=(n:number)=>{const at=this.settings.loopMode==="wrap"?((n%length)+length)%length:n;if(at>=0&&at<length&&!seen.has(at)){seen.add(at);indexes.push(at)}};
    add(this.index);
    const gifs=indexes.map(i=>items[i]).filter(item=>item?.type==="gif");if(!gifs.length)return;
    try{
      const mod=await this.loadGifModule();
      await Promise.allSettled(gifs.map(item=>mod.prepareGif(item.originalUrl,this.settings.gifDecodeMaxMb)));
    }catch{}
  }
  private async mountGif(item:MediaItem,version:number){
    try{
      const mod=await this.loadGifModule();
      if(version!==this.renderVersion||this.view!=="focus"||this.result?.items[this.index]!==item)return;
      const player=new mod.GifPlayer(this.stage,item.originalUrl,this.settings,message=>this.toast(message));this.gifPlayer=player;await player.init();
    }catch(error){
      if(version!==this.renderVersion)return;
      const mount=this.stage.querySelector(".lp-gif-mount");
      if(mount)mount.innerHTML=`<div class="lp-gif-fallback"><img class="lp-image" src="${this.escape(item.originalUrl)}" alt="Animated GIF"><span>Native GIF playback</span></div>`;
      this.toast(error instanceof Error?error.message:"GIF controls unavailable");
    }
  }
  private shell(title:string,body:string,status:string){const density=this.settings?.quickViewControls&&this.view==="grid"?`<button class="lp-btn lp-grid-more" title="Smaller thumbnails" aria-label="Smaller thumbnails">−</button><button class="lp-btn lp-grid-bigger" title="Larger thumbnails" aria-label="Larger thumbnails">+</button>`:"";const expand=this.settings?.quickViewControls?`<button class="lp-btn lp-expandbtn" aria-pressed="${this.expanded}" title="${this.expanded?"Restore view":"Expand view"}" aria-label="${this.expanded?"Restore view":"Expand view"}">${this.expanded?"↙":"⛶"}</button>`:"";const gridToggle=this.view==="grid"?`<button class="lp-btn lp-gridbtn" title="Single image (G)" aria-label="Back to single image">▣</button>`:`<button class="lp-btn lp-gridbtn" title="Media grid (G)" aria-label="Show image grid">▦</button>`;const browse=this.view==="focus"&&this.result?.items.length?`<button class="lp-nav lp-previous" title="Previous media" aria-label="Previous media">↑</button><span class="lp-count">${this.index+1} / ${this.result.items.length}</span><button class="lp-nav lp-next" title="Next media" aria-label="Next media">↓</button>`:`<span class="lp-count">${this.result?.items.length?this.index+1:0} / ${this.result?.items.length??0}</span>`;return `<header class="lp-head"><span class="lp-title">${this.escape(title)}</span><span class="lp-meta">${this.result?.items.length??""}</span>${density}${gridToggle}${expand}<button class="lp-btn lp-favorite" aria-pressed="${this.favorite}" title="${this.favorite?"Remove saved link (B)":"Save link (B)"}" aria-label="${this.favorite?"Remove saved link":"Save link"}">${this.favorite?"★":"☆"}</button><button class="lp-btn lp-helpbtn" title="Controls (?)" aria-label="Show controls">?</button><button class="lp-btn lp-pin" aria-pressed="${this.pinned}" title="Pin preview (P)" aria-label="Pin preview">⌖</button><button class="lp-btn lp-close" title="Close (Escape)" aria-label="Close">×</button></header>${body}<footer class="lp-foot">${browse}<span>${this.result?.items[this.index]?.postNumber?`Post #${this.result.items[this.index].postNumber}`:""}</span>${this.view==="grid"?`<span>${Math.round(this.gridThumbSize)}px tiles</span>`:""}<span class="lp-spacer"></span><span class="lp-signal">${this.escape(status)}</span></footer>${this.help?this.helpMarkup():""}`;}
  private grid(){const r=this.result!;const scanning=!r.complete?`<div class="lp-grid-progress"><span class="lp-loading-dot"></span><span>Scanning thread · ${r.postsScanned??0}/${r.totalPosts??"?"} posts · ${r.items.length} media found</span></div>`:"";return `${scanning}<div class="lp-grid" data-total="${r.items.length}" data-complete="${r.complete}" role="grid" aria-label="Media grid"><div class="lp-grid-spacer"></div><div class="lp-grid-window"></div></div>`}
  private setupVirtualGrid(){
    const grid=this.panel.querySelector(".lp-grid") as HTMLDivElement|null,windowEl=this.panel.querySelector(".lp-grid-window") as HTMLDivElement|null,spacer=this.panel.querySelector(".lp-grid-spacer") as HTMLDivElement|null;
    if(!grid||!windowEl||!spacer||!this.result)return;
    const items=this.result.items,gap=6,pad=8,cell=Math.max(48,this.gridThumbSize),overscan=2;
    let raf=0,lastStart=-1,lastEnd=-1,lastCols=-1;
    const renderWindow=()=>{
      raf=0;
      const inner=Math.max(cell,grid.clientWidth-pad*2),cols=Math.max(1,Math.floor((inner+gap)/(cell+gap))),rowHeight=cell+gap,rows=Math.ceil(items.length/cols);
      spacer.style.height=`${pad*2+Math.max(0,rows*rowHeight-gap)}px`;
      const startRow=Math.max(0,Math.floor(grid.scrollTop/rowHeight)-overscan),endRow=Math.min(rows,Math.ceil((grid.scrollTop+grid.clientHeight)/rowHeight)+overscan);
      const start=startRow*cols,end=Math.min(items.length,endRow*cols);
      if(start===lastStart&&end===lastEnd&&cols===lastCols)return;lastStart=start;lastEnd=end;lastCols=cols;
      const chunks:string[]=[];
      for(let n=start;n<end;n++){
        const item=items[n],row=Math.floor(n/cols),col=n%cols,left=pad+col*(cell+gap),top=pad+row*rowHeight;
        chunks.push(`<button class="lp-thumb" data-i="${n}" aria-current="${n===this.index}" style="left:${left}px;top:${top}px;width:${cell}px;height:${cell}px" role="gridcell"><img src="${this.escape(item.previewUrl)}" alt="" loading="lazy" decoding="async" fetchpriority="low"></button>`);
      }
      windowEl.innerHTML=chunks.join("");
    };
    const schedule=()=>{if(!raf)raf=requestAnimationFrame(renderWindow)};
    const onClick=(event:Event)=>{
      const thumb=(event.target as Element).closest?.(".lp-thumb") as HTMLElement|null;if(!thumb)return;
      this.index=Number(thumb.dataset.i);this.view="focus";this.persistViewerState();this.render();
    };
    const onScroll=()=>{this.gridScrollTop=grid.scrollTop;schedule()};
    grid.addEventListener("scroll",onScroll,{passive:true});grid.addEventListener("click",onClick);
    const ro=new ResizeObserver(schedule);ro.observe(grid);
    const row=Math.floor(this.index/Math.max(1,Math.floor((Math.max(cell,grid.clientWidth-pad*2)+gap)/(cell+gap))));
    grid.scrollTop=this.gridScrollTop||Math.max(0,row*(cell+gap)-cell);
    renderWindow();
    this.gridCleanup=()=>{if(raf)cancelAnimationFrame(raf);ro.disconnect();grid.removeEventListener("scroll",onScroll);grid.removeEventListener("click",onClick)};
  }
  private helpMarkup(){const gif=this.result?.items[this.index]?.type==="gif"?`<kbd>Space</kbd><span>GIF play / pause</span><kbd>, / .</kbd><span>Previous / next GIF frame</span><kbd>[ / ]</kbd><span>GIF slower / faster</span><kbd>timeline scroll</kbd><span>Scrub GIF frames</span>`:"";return `<div class="lp-help"><h3>One-hand controls</h3><div class="lp-help-grid"><kbd>scroll / ↑ ↓</kbd><span>Previous / next media</span><kbd>horizontal scroll</kbd><span>Fast scrub</span><kbd>pinch</kbd><span>Zoom</span><kbd>double click</kbd><span>Zoom at pointer / reset</span><kbd>double-click + drag</kbd><span>Pan while zoomed</span>${gif}<kbd>G</kbd><span>Grid / focus</span><kbd>B</kbd><span>Save link</span><kbd>P</kbd><span>Pin preview</span><kbd>O</kbd><span>Open original</span><kbd>D</kbd><span>Download original</span><kbd>Esc</kbd><span>Close</span></div></div>`}
  private bind(){
    this.panel.querySelector(".lp-close")?.addEventListener("click",()=>this.close(true));
    this.panel.querySelector(".lp-pin")?.addEventListener("click",()=>{this.pinned=!this.pinned;this.render()});
    this.panel.querySelector(".lp-gridbtn")?.addEventListener("click",()=>this.toggleView());
    this.panel.querySelector(".lp-expandbtn")?.addEventListener("click",()=>{this.expanded=!this.expanded;this.persistViewerState();this.render()});
    this.panel.querySelector(".lp-grid-more")?.addEventListener("click",()=>{this.gridThumbSize=Math.max(48,this.gridThumbSize-16);this.persistViewerState();this.render();this.toast(`${this.gridThumbSize}px tiles`)});
    this.panel.querySelector(".lp-grid-bigger")?.addEventListener("click",()=>{this.gridThumbSize=Math.min(320,this.gridThumbSize+16);this.persistViewerState();this.render();this.toast(`${this.gridThumbSize}px tiles`)});
    this.panel.querySelector(".lp-favorite")?.addEventListener("click",()=>void this.toggleFavorite());
    this.panel.querySelector(".lp-previous")?.addEventListener("click",()=>this.move(-1));
    this.panel.querySelector(".lp-next")?.addEventListener("click",()=>this.move(1));
    this.panel.querySelector(".lp-helpbtn")?.addEventListener("click",()=>{this.help=!this.help;this.render()});
    this.panel.onmouseenter=()=>{if(this.closeTimer)clearTimeout(this.closeTimer)};
    this.panel.onmouseleave=()=>{if(!this.pinned)this.closeTimer=window.setTimeout(()=>this.close(),this.settings.closeDelay)};
  }
  key(e:KeyboardEvent){
    if(!this.root.childElementCount)return false;
    const target=e.target as HTMLElement|null;if(target?.matches("input,textarea,select,[contenteditable]:not([contenteditable='false'])")&&!e.composedPath().includes(this.host))return false;
    if(this.gifPlayer?.key(e))return true;
    const hit=(action:string,fallback:string[]=[])=>[...(this.settings.shortcuts[action]??[]),...fallback].some(k=>k.toLowerCase()===e.key.toLowerCase());
    if(hit("close",["Escape"])){this.close(true);return true}
    if(hit("grid",["g"])){this.toggleView();return true}
    if(hit("pin",["p"])){this.pinned=!this.pinned;this.render();return true}
    if(hit("favorite",["b"])){void this.toggleFavorite();return true}
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
  move(delta:number){void this.navigate(delta)}
  private async navigate(delta:number){if(!this.result?.items.length)return;const items=this.result.items,max=items.length-1,base=this.desiredIndex??this.index;let n=base+delta;if(this.settings.loopMode==="wrap")n=(n+items.length)%items.length;else n=Math.max(0,Math.min(max,n));if(n===base)return;this.desiredIndex=n;const version=++this.navigationVersion;this.preloader.schedule(n,Math.sign(delta));await this.preloader.ensure(items[n]);if(version!==this.navigationVersion||this.desiredIndex!==n||!this.result)return;this.index=n;this.desiredIndex=null;if(this.settings.resetZoomPerImage){this.zoom=1;this.tx=this.ty=0}this.render()}
  quickZoom(x:number,y:number){if(this.zoom>1.01&&this.settings.secondDoubleClick==="fit"){this.zoom=1;this.tx=this.ty=0;this.paintTransform();this.toast("Fit");return}const target=Math.max(1,this.settings.doubleClickZoom);this.applyZoom(target/this.zoom,x,y)}
  applyZoom(factor:number,x:number,y:number){const old=this.zoom;this.zoom=Math.max(this.settings.minZoom,Math.min(this.settings.maxZoom,this.zoom*factor));if(old===this.zoom&&factor>1&&old>1){this.zoom=1;this.tx=this.ty=0}else{const ratio=this.zoom/old;this.tx=x-(x-this.tx)*ratio;this.ty=y-(y-this.ty)*ratio}this.paintTransform();this.toast(`${Math.round(this.zoom*100)}%`)}
  pan(dx:number,dy:number){if(this.zoom<=1&&this.settings.verticalGesture!=="pan")return;this.tx+=dx;this.ty+=dy;this.paintTransform()}
  onDoubleClick(x:number,y:number){if(this.settings.doubleClick==="next"){this.move(1);return}if(this.settings.doubleClick==="fullscreen"){if(document.fullscreenElement)void document.exitFullscreen();else void this.panel.requestFullscreen?.();return}if(this.zoom>1&&this.settings.secondDoubleClick==="fit"){this.zoom=1;this.tx=this.ty=0;this.paintTransform();this.toast("Fit");return}this.applyZoom(this.settings.doubleClickZoom,x,y)}
  private async refreshFavorite(){
    if(!this.result)return;const version=++this.favoriteVersion,url=this.result.url;
    try{const value=await isFavorite(url);if(version===this.favoriteVersion&&this.result?.url===url&&this.favorite!==value){this.favorite=value;this.render()}}catch{}
  }
  private async toggleFavorite(){
    if(!this.result)return;const current=this.result;
    try{
      const result=await toggleFavorite({url:current.url,title:current.title||new URL(current.url).hostname,mediaCount:current.items.length});
      if(this.result?.url!==current.url)return;this.favorite=result.saved;this.render();this.toast(result.saved?"Link saved":"Saved link removed");
    }catch{this.toast("Couldn’t update favorite")}
  }
  paintTransform(){const img=this.panel.querySelector(".lp-image") as HTMLElement|null;if(img)img.style.transform=`translate(${this.tx}px,${this.ty}px) scale(${this.zoom})`}
  toast(text:string){const t=document.createElement("div");t.className="lp-toast";t.textContent=text;this.panel.appendChild(t);setTimeout(()=>t.remove(),650)}
  position(x:number,y:number){const w=this.settings.panelWidth,h=480,g=this.settings.pointerGap;let left=x+g,top=y+g;if(left+w>innerWidth-12)left=Math.max(12,x-w-g);if(top+h>innerHeight-12)top=Math.max(12,y-h-g);this.panel.style.left=`${left}px`;this.panel.style.top=`${top}px`;this.panel.style.setProperty("--lp-width",`${w}px`);this.panel.style.setProperty("--lp-maxh",`${this.settings.panelMaxVh}vh`);this.panel.style.setProperty("--lp-stageh",`${this.settings.focusHeightVh}vh`);this.panel.style.setProperty("--lp-expandedw",`${this.settings.expandedWidthVw}vw`);this.panel.style.setProperty("--lp-expandedh",`${this.settings.expandedHeightVh}vh`);this.panel.style.setProperty("--lp-thumb",`${this.gridThumbSize}px`);this.panel.style.opacity=String(this.settings.panelOpacity);this.panel.style.background=`rgba(17,21,18,${Math.max(.1,1-this.settings.transparency)})`;this.panel.style.backdropFilter=`blur(${this.settings.blur}px)`;if(this.settings.motion==="none"||this.settings.reducedMotion)this.panel.style.animation="none"}
  private escape(v:string){return v.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!))}
}
