import {classifyLink,type ScanResult} from "./shared/media";
import {effectiveSettings,loadSettings,type LinkPeekSettings} from "./shared/settings";
import {Viewer} from "./ui/viewer";

type ActiveScan={url:string;token:string;settings:LinkPeekSettings};

let settings:LinkPeekSettings;const viewer=new Viewer();
let hoverTimer:number|undefined,hoverRearmTimer:number|undefined,currentAnchor:HTMLAnchorElement|null=null,requestId=0,startX=0,startY=0,lastPointerX=innerWidth/2,lastPointerY=innerHeight/2;
let activeScan:ActiveScan|undefined;const prefetched=new Set<string>();

async function boot(){
  settings=await loadSettings();
  const storedView=await chrome.storage.local.get("viewerState");
  viewer.restoreViewerState(storedView.viewerState as {view?:"focus"|"grid";gridThumbSize?:number;expanded?:boolean}|undefined);
  chrome.storage.onChanged.addListener(async()=>{settings=await loadSettings()});
  chrome.runtime.onMessage.addListener(msg=>{
    if(msg?.type!=="LINKPEEK_SCAN_PROGRESS"||!activeScan||msg.token!==activeScan.token||msg.url!==activeScan.url)return;
    const result=msg.result as ScanResult;if(result?.items)viewer.show(result);
  });
  document.addEventListener("pointerover",onOver,true);document.addEventListener("pointerout",onOut,true);document.addEventListener("pointermove",onMove,true);
  document.addEventListener("keydown",e=>{if(viewer.key(e)){e.preventDefault();e.stopPropagation()}},true);
  document.addEventListener("click",e=>{if(settings.activationMode!=="click")return;const a=(e.target as Element).closest?.("a[href]") as HTMLAnchorElement|null;if(!a)return;e.preventDefault();activate(a,e.clientX,e.clientY)},true);
  if(settings.prefetch!=="off")requestIdleCallback(()=>prefetchVisible(),{timeout:2500});
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
  const eff=effectiveSettings(settings,a.href);if(!eff.enabled)return;const kind=classifyLink(a.href);if(["anchor","download","ignored"].includes(kind))return;
  clear();startX=x;startY=y;hoverTimer=window.setTimeout(()=>{hoverTimer=undefined;if(currentAnchor===a)activate(a,lastPointerX,lastPointerY)},delay??eff.hoverDelay);
}
function onOver(e:PointerEvent){
  lastPointerX=e.clientX;lastPointerY=e.clientY;if(settings.activationMode==="click")return;
  const a=(e.target as Element).closest?.("a[href]") as HTMLAnchorElement|null;if(!a)return;
  if(a===currentAnchor){if(!hoverTimer&&!activeScan&&settings.activationMode!=="modifier")armHover(a,e.clientX,e.clientY);return}
  if(activeScan&&!viewer.pinned)detachOrCancel(activeScan,"switch");
  currentAnchor=a;if(settings.activationMode==="modifier"&&!e.altKey)return;armHover(a,e.clientX,e.clientY);
}
function onMove(e:PointerEvent){
  lastPointerX=e.clientX;lastPointerY=e.clientY;if(!currentAnchor)return;
  const eff=effectiveSettings(settings,currentAnchor.href);
  if(settings.activationMode==="modifier"){
    if(!e.altKey){clear();return}
    if(!hoverTimer){armHover(currentAnchor,e.clientX,e.clientY);return}
  }
  if(hoverTimer&&Math.hypot(e.clientX-startX,e.clientY-startY)>eff.cancelMovePx){
    clearTimeout(hoverTimer);hoverTimer=undefined;
  }
  if(!hoverTimer&&!activeScan&&settings.activationMode!=="click"){
    if(hoverRearmTimer)clearTimeout(hoverRearmTimer);
    const anchor=currentAnchor,x=e.clientX,y=e.clientY;
    hoverRearmTimer=window.setTimeout(()=>{hoverRearmTimer=undefined;if(currentAnchor===anchor)armHover(anchor,x,y,Math.min(160,eff.hoverDelay))},90);
  }
}
function onOut(e:PointerEvent){
  const a=(e.target as Element).closest?.("a[href]") as HTMLAnchorElement|null;if(!a||a!==currentAnchor)return;
  const to=e.relatedTarget as Node|null;if(to&&(a.contains(to)||viewer.host.contains(to)))return;clear();
  if(!viewer.pinned){
    requestId++;
    if(activeScan)detachOrCancel(activeScan,"out");
    viewer.closeTimer=window.setTimeout(()=>viewer.close(),effectiveSettings(settings,a.href).closeDelay);
  }
  currentAnchor=null;
}
function clear(){if(hoverTimer)clearTimeout(hoverTimer);if(hoverRearmTimer)clearTimeout(hoverRearmTimer);hoverTimer=undefined;hoverRearmTimer=undefined}
async function activate(a:HTMLAnchorElement,x:number,y:number){
  clear();if(activeScan)detachOrCancel(activeScan,"switch");
  const id=++requestId,eff=effectiveSettings(settings,a.href),kind=classifyLink(a.href),token=`${Date.now()}-${id}-${Math.random().toString(36).slice(2)}`;
  const scan={url:a.href,token,settings:eff};activeScan=scan;
  viewer.openLoading(x,y,eff,a.textContent?.trim().slice(0,80)||"Scanning link…");
  try{
    const result=await chrome.runtime.sendMessage({type:"LINKPEEK_SCAN",url:a.href,kind,token}) as ScanResult&{error?:string;cancelled?:boolean};
    if(id!==requestId||activeScan?.token!==token)return;if(result.cancelled)return;if(result.error)throw new Error(result.error);viewer.show(result);
  }catch(err){if(id===requestId&&activeScan?.token===token)viewer.error(err instanceof Error?err.message:String(err))}
  finally{if(activeScan?.token===token)activeScan=undefined}
}
function prefetchVisible(){
  if(!settings.enabled||settings.prefetch==="off")return;
  const candidates=[...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map(a=>{
    const r=a.getBoundingClientRect(),kind=classifyLink(a.href);if(kind!=="discourse"||r.bottom<-innerHeight||r.top>innerHeight*2||r.right<0||r.left>innerWidth)return null;
    const x=Math.max(r.left,Math.min(lastPointerX,r.right)),y=Math.max(r.top,Math.min(lastPointerY,r.bottom));
    return {a,kind,score:Math.hypot(lastPointerX-x,lastPointerY-y)};
  }).filter((x):x is NonNullable<typeof x>=>!!x).sort((a,b)=>a.score-b.score);
  const limit=settings.prefetch==="nearby"?2:settings.prefetch==="visible"?6:12,queue=candidates.slice(0,limit);
  const concurrency=settings.prefetch==="nearby"?Math.min(2,Math.max(1,settings.maxRequests)):Math.min(4,Math.max(1,settings.maxRequests));
  let active=0,index=0;
  const next=()=>{
    while(active<concurrency&&index<queue.length){
      const {a,kind}=queue[index++];if(prefetched.has(a.href))continue;prefetched.add(a.href);active++;
      chrome.runtime.sendMessage({type:"LINKPEEK_PREFETCH",url:a.href,kind}).finally(()=>{active--;next()});
    }
  };next();
}
boot();
