import {classifyLink,type ScanResult} from "./shared/media";
import {effectiveSettings,linkMatchesKeywords,loadSettings,type LinkPeekSettings} from "./shared/settings";
import {Viewer} from "./ui/viewer";

type ActiveScan={url:string;token:string;settings:LinkPeekSettings};

let settings:LinkPeekSettings;const viewer=new Viewer();
let hoverTimer:number|undefined,hoverRearmTimer:number|undefined,deepPrefetchTimer:number|undefined,prefetchTimer:number|undefined,currentAnchor:HTMLAnchorElement|null=null,currentAnchorUrl:string|null=null,openAnchor:HTMLAnchorElement|null=null,openAnchorUrl:string|null=null,requestId=0,startX=0,startY=0,lastPointerX=innerWidth/2,lastPointerY=innerHeight/2,lastAltKey=false;
type WarmTask={url:string;img:HTMLImageElement;priority:number};
let activeScan:ActiveScan|undefined,prefetchActive=0,warmActive=0,warmIdleHandle:number|undefined;const prefetched=new Map<string,"shallow"|"deep">(),warmedPreviews=new Map<string,HTMLImageElement>(),prefetchWaiters:Array<()=>void>=[],warmQueue:WarmTask[]=[],warmIdleQueue:WarmTask[]=[];

async function boot(){
  settings=await loadSettings();
  const storedView=await chrome.storage.local.get("viewerState");
  viewer.restoreViewerState(storedView.viewerState as Parameters<Viewer["restoreViewerState"]>[0]);
  chrome.storage.onChanged.addListener(async()=>{settings=await loadSettings()});
  chrome.runtime.onMessage.addListener(msg=>{
    if(msg?.type!=="LINKPEEK_SCAN_PROGRESS"||!activeScan||msg.token!==activeScan.token||msg.url!==activeScan.url)return;
    const result=msg.result as ScanResult;if(result?.items)viewer.show(result);
  });
  document.addEventListener("pointerover",onOver,true);document.addEventListener("pointerout",onOut,true);document.addEventListener("pointermove",onMove,true);
  document.addEventListener("scroll",schedulePrefetch,true);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden){schedulePrefetch();scheduleIdleWarm()}},true);
  new MutationObserver(()=>{if(!settings.mutationObserver)return;schedulePrefetch();if(settings.activationMode==="click")return;const target=document.elementFromPoint?.(lastPointerX,lastPointerY),a=target?.closest?.("a[href]") as HTMLAnchorElement|null;if(a)considerAnchor(a,lastPointerX,lastPointerY,lastAltKey)}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["href"]});
  document.addEventListener("keydown",e=>{if(viewer.key(e)){e.preventDefault();e.stopPropagation()}},true);
  document.addEventListener("click",e=>{if(settings.activationMode!=="click")return;const a=(e.target as Element).closest?.("a[href]") as HTMLAnchorElement|null;if(!a)return;const eff=effectiveSettings(settings,a.href);if(!eff.enabled||!linkMatchesKeywords(eff,a.href))return;e.preventDefault();activate(a,e.clientX,e.clientY)},true);
  viewer.onDismiss=()=>{requestId++;if(activeScan)detachOrCancel(activeScan,"out");openAnchor=null;openAnchorUrl=null;currentAnchor=null;currentAnchorUrl=null;clear()};
  if(settings.prefetch!=="off")runPrefetch(1200);
}
function cancelScan(scan:ActiveScan){
  chrome.runtime.sendMessage({type:"LINKPEEK_CANCEL_SCAN",url:scan.url,token:scan.token}).catch(()=>{});
  if(activeScan?.token===scan.token)activeScan=undefined;
}
function detachOrCancel(scan:ActiveScan,reason:"switch"|"out"){
  const mode=scan.settings.continueAfterClose;
  if(mode==="always"){if(activeScan?.token===scan.token)activeScan=undefined;return}
  if(mode==="brief"&&reason==="out"){
    if(activeScan?.token===scan.token)activeScan=undefined;
    window.setTimeout(()=>cancelScan(scan),1000);return;
  }
  cancelScan(scan);
}
function armHover(a:HTMLAnchorElement,x:number,y:number,delay?:number){
  const url=a.href,eff=effectiveSettings(settings,url),kind=classifyLink(url);if(["anchor","download","ignored"].includes(kind))return;
  clear();startX=x;startY=y;hoverTimer=window.setTimeout(()=>{hoverTimer=undefined;if(currentAnchor===a&&currentAnchorUrl===url)activate(a,lastPointerX,lastPointerY)},delay??eff.hoverDelay);
}
function onOver(e:PointerEvent){
  lastPointerX=e.clientX;lastPointerY=e.clientY;lastAltKey=e.altKey;if(settings.activationMode==="click")return;
  if(e.composedPath().includes(viewer.host)){if(viewer.closeTimer)clearTimeout(viewer.closeTimer);return}
  const a=(e.target as Element).closest?.("a[href]") as HTMLAnchorElement|null;if(!a)return;
  considerAnchor(a,e.clientX,e.clientY,e.altKey);
}
function considerAnchor(a:HTMLAnchorElement,x:number,y:number,altKey:boolean){
  const eff=effectiveSettings(settings,a.href);if(!eff.enabled||!linkMatchesKeywords(eff,a.href)){if(currentAnchor===a){clear();currentAnchor=null;currentAnchorUrl=null}return}
  void prefetchAnchor(a);
  if(viewer.pinned&&viewer.isOpen)return;
  if(a===openAnchor&&a.href===openAnchorUrl)return;
  if(a===currentAnchor&&a.href===currentAnchorUrl){if(!hoverTimer&&settings.activationMode!=="modifier")armHover(a,x,y);armDeepPrefetch(a);return}
  if(activeScan&&!viewer.pinned)detachOrCancel(activeScan,"switch");
  currentAnchor=a;currentAnchorUrl=a.href;if(settings.activationMode==="modifier"&&!altKey)return;armHover(a,x,y);armDeepPrefetch(a);
}
function armDeepPrefetch(a:HTMLAnchorElement){
  const url=a.href,eff=effectiveSettings(settings,url);if(eff.recursiveSearch==="off"||deepPrefetchTimer)return;
  deepPrefetchTimer=window.setTimeout(()=>{deepPrefetchTimer=undefined;if(currentAnchor===a&&currentAnchorUrl===url)void prefetchAnchor(a,true)},Math.min(100,Math.max(0,eff.hoverDelay*.35)));
}
function onMove(e:PointerEvent){
  lastPointerX=e.clientX;lastPointerY=e.clientY;lastAltKey=e.altKey;schedulePrefetch();if(!e.composedPath().includes(viewer.host)&&settings.activationMode!=="click"){const a=(e.target as Element).closest?.("a[href]") as HTMLAnchorElement|null;if(a&&(a!==currentAnchor||a.href!==currentAnchorUrl))considerAnchor(a,e.clientX,e.clientY,e.altKey)}if(viewer.containsPoint(e.clientX,e.clientY,currentAnchor?.getBoundingClientRect())){if(viewer.closeTimer)clearTimeout(viewer.closeTimer);return}if(!currentAnchor||(currentAnchor===openAnchor&&currentAnchorUrl===openAnchorUrl))return;
  const eff=effectiveSettings(settings,currentAnchor.href);
  if(settings.activationMode==="modifier"){
    if(!e.altKey){clear();return}
    if(!hoverTimer){armHover(currentAnchor,e.clientX,e.clientY);return}
  }
  if(hoverTimer&&Math.hypot(e.clientX-startX,e.clientY-startY)>eff.cancelMovePx){
    clearTimeout(hoverTimer);clearTimeout(deepPrefetchTimer);hoverTimer=undefined;deepPrefetchTimer=undefined;
  }
  if(!hoverTimer&&!activeScan&&settings.activationMode!=="click"){
    if(hoverRearmTimer)clearTimeout(hoverRearmTimer);
    const anchor=currentAnchor,x=e.clientX,y=e.clientY;
    const url=anchor.href;hoverRearmTimer=window.setTimeout(()=>{hoverRearmTimer=undefined;if(currentAnchor===anchor&&currentAnchorUrl===url)armHover(anchor,x,y,Math.min(160,eff.hoverDelay))},90);
  }
}
function onOut(e:PointerEvent){
  const a=(e.target as Element).closest?.("a[href]") as HTMLAnchorElement|null;if(!a||a!==currentAnchor)return;
  const to=e.relatedTarget as Node|null;if(to&&(a.contains(to)||viewer.host===to||viewer.host.contains(to)))return;clear();
  if(!viewer.pinned){
    requestId++;
    if(activeScan)detachOrCancel(activeScan,"out");
    viewer.closeTimer=window.setTimeout(()=>viewer.close(),effectiveSettings(settings,a.href).closeDelay);
  }
  if(a!==openAnchor||a.href!==openAnchorUrl){currentAnchor=null;currentAnchorUrl=null}
}
function clear(){clearTimeout(hoverTimer);clearTimeout(hoverRearmTimer);clearTimeout(deepPrefetchTimer);hoverTimer=undefined;hoverRearmTimer=undefined;deepPrefetchTimer=undefined}
async function activate(a:HTMLAnchorElement,x:number,y:number){
  clear();if(openAnchor===a&&a.href===openAnchorUrl)return;if(activeScan)detachOrCancel(activeScan,"switch");
  const eff=effectiveSettings(settings,a.href);if(!eff.enabled||!linkMatchesKeywords(eff,a.href))return;const id=++requestId,kind=classifyLink(a.href),token=`${Date.now()}-${id}-${Math.random().toString(36).slice(2)}`;
  const scan={url:a.href,token,settings:eff};activeScan=scan;openAnchor=a;openAnchorUrl=a.href;
  viewer.openLoading(x,y,eff,a.textContent?.trim().slice(0,80)||"Scanning link…");
  try{
    const result=await chrome.runtime.sendMessage({type:"LINKPEEK_SCAN",url:a.href,kind,token}) as ScanResult&{error?:string;cancelled?:boolean};
    if(id!==requestId||activeScan?.token!==token)return;if(result.cancelled)return;if(result.error)throw new Error(result.error);viewer.show(result);
  }catch(err){if(id===requestId&&activeScan?.token===token)viewer.error(err instanceof Error?err.message:String(err))}
  finally{if(activeScan?.token===token)activeScan=undefined}
}
function schedulePrefetch(){
  if(settings?.prefetch==="off"||document.hidden)return;
  clearTimeout(prefetchTimer);prefetchTimer=window.setTimeout(()=>runPrefetch(600),180);
}
function runPrefetch(timeout:number){if(settings.idlePrefetch)requestIdleCallback(()=>prefetchVisible(),{timeout});else prefetchVisible()}
function constrainedConnection(eff:LinkPeekSettings){
  const connection=(navigator as Navigator&{connection?:{saveData?:boolean;effectiveType?:string}}).connection;
  return eff.meteredOff&&(connection?.saveData===true||connection?.effectiveType==="slow-2g"||connection?.effectiveType==="2g");
}
function addWarmTask(url:string,priority:number,target:WarmTask[]){
  if(!url||warmedPreviews.has(url))return;
  if(target===warmIdleQueue&&target.length>=120){const dropped=target.shift()!;warmedPreviews.delete(dropped.url)}
  const img=new Image();warmedPreviews.set(url,img);target.push({url,img,priority});
}
function scheduleIdleWarm(){
  if(warmIdleHandle!=null||!warmIdleQueue.length||document.hidden)return;
  warmIdleHandle=window.requestIdleCallback(deadline=>{
    warmIdleHandle=undefined;if(document.hidden)return;let count=0;
    while(warmIdleQueue.length&&count<8&&(deadline.didTimeout||deadline.timeRemaining()>4)){warmQueue.push(warmIdleQueue.shift()!);count++}
    warmQueue.sort((a,b)=>a.priority-b.priority);pumpWarmQueue();scheduleIdleWarm();
  },{timeout:1500});
}
function warmPreviewUrls(result:ScanResult|undefined,eff:LinkPeekSettings,deep:boolean){
  if(!result?.items?.length)return;
  const urls=[...new Set(result.items.map(item=>item.previewUrl).filter(Boolean))];
  const constrained=constrainedConnection(eff),dataSaver=eff.networkMode==="data"||constrained;
  const immediate=deep&&!dataSaver?Math.max(12,1+eff.preloadNext+eff.preloadPrevious):dataSaver?1:Math.min(3,1+eff.preloadNext+eff.preloadPrevious);
  let configuredLimit=eff.preloadRestLimit;if(configuredLimit<=0)configuredLimit=urls.length;
  let speculativeLimit=60;if(eff.networkMode==="aggressive")speculativeLimit=120;
  const total=deep&&!dataSaver&&eff.preloadRest!=="off"?Math.min(urls.length,configuredLimit,speculativeLimit):Math.min(urls.length,immediate);
  for(const url of urls.slice(0,Math.min(immediate,total)))addWarmTask(url,0,warmQueue);
  const rest=urls.slice(Math.min(immediate,total),total);
  for(const url of rest)addWarmTask(url,2,eff.preloadRest==="all"?warmQueue:warmIdleQueue);
  const retain=Math.max(24,Math.min(128,configuredLimit+12));while(warmedPreviews.size>retain)warmedPreviews.delete(warmedPreviews.keys().next().value!);
  warmQueue.sort((a,b)=>a.priority-b.priority);
  pumpWarmQueue();
  scheduleIdleWarm();
}
function pumpWarmQueue(){
  while(warmActive<3&&warmQueue.length){
    const {url,img}=warmQueue.shift()!;
    warmActive++;img.decoding="async";(img as HTMLImageElement&{fetchPriority?:string}).fetchPriority="low";
    img.addEventListener("load",finishWarm,{once:true});img.addEventListener("error",finishWarm,{once:true});img.src=url;
  }
}
function finishWarm(){
  warmActive--;
  pumpWarmQueue();
}
async function withPrefetchSlot<T>(work:()=>Promise<T>){
  const limit=Math.max(1,Math.min(4,settings.maxRequests));
  if(prefetchActive>=limit)await new Promise<void>(resolve=>prefetchWaiters.push(resolve));
  prefetchActive++;
  try{return await work()}finally{prefetchActive--;prefetchWaiters.shift()?.()}
}
async function prefetchAnchor(a:HTMLAnchorElement,deep=false){
  const eff=effectiveSettings(settings,a.href),level=deep&&eff.recursiveSearch!=="off"?"deep":"shallow",previous=prefetched.get(a.href);
  if(!eff.enabled||!linkMatchesKeywords(eff,a.href)||eff.prefetch==="off"||document.hidden||constrainedConnection(eff)||previous==="deep"||(!deep&&previous))return;
  const kind=classifyLink(a.href);if(!["discourse","direct-image","generic"].includes(kind))return;
  prefetched.set(a.href,level);
  try{
    const result=await withPrefetchSlot(()=>chrome.runtime.sendMessage({type:"LINKPEEK_PREFETCH",url:a.href,kind,deep:level==="deep"}) as Promise<ScanResult>);
    warmPreviewUrls(result,eff,level==="deep");
  }catch{if(previous)prefetched.set(a.href,previous);else prefetched.delete(a.href)}
}
function prefetchVisible(){
  if(!settings.enabled||settings.prefetch==="off")return;
  const candidates=[...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map(a=>{
    const r=a.getBoundingClientRect(),kind=classifyLink(a.href),eff=effectiveSettings(settings,a.href),radius=Math.max(0,settings.prefetchRadius)*innerHeight;if(!eff.enabled||!linkMatchesKeywords(eff,a.href)||!["discourse","direct-image","generic"].includes(kind)||r.bottom < -radius||r.top>innerHeight+radius||r.right<0||r.left>innerWidth)return null;
    const x=Math.max(r.left,Math.min(lastPointerX,r.right)),y=Math.max(r.top,Math.min(lastPointerY,r.bottom));
    return {a,kind,score:Math.hypot(lastPointerX-x,lastPointerY-y)};
  }).filter((x):x is NonNullable<typeof x>=>!!x).sort((a,b)=>a.score-b.score);
  const limit=settings.prefetch==="nearby"?3:settings.prefetch==="visible"?6:12,queue=candidates.slice(0,limit);
  const concurrency=Math.min(4,Math.max(1,settings.maxRequests));
  let active=0,index=0;
  const next=()=>{
    while(active<concurrency&&index<queue.length){
      const {a}=queue[index++];if(prefetched.has(a.href))continue;active++;
      prefetchAnchor(a).finally(()=>{active--;next()});
    }
  };next();
}
boot();
