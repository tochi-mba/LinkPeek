import {classifyLink,type ScanResult} from "./shared/media";
import {effectiveSettings,loadSettings,type LinkPeekSettings} from "./shared/settings";
import {Viewer} from "./ui/viewer";

let settings:LinkPeekSettings;const viewer=new Viewer();
let hoverTimer:number|undefined,currentAnchor:HTMLAnchorElement|null=null,requestId=0,startX=0,startY=0,lastPointerX=innerWidth/2,lastPointerY=innerHeight/2;
let activeScan:{url:string;token:string}|undefined;const prefetched=new Set<string>();

async function boot(){
  settings=await loadSettings();
  chrome.storage.onChanged.addListener(async()=>{settings=await loadSettings()});
  chrome.runtime.onMessage.addListener(msg=>{
    if(msg?.type!=="LINKPEEK_SCAN_PROGRESS"||!activeScan||msg.url!==activeScan.url||msg.token!==activeScan.token)return;
    const result=msg.result as ScanResult;if(result?.items)viewer.show(result);
  });
  document.addEventListener("pointerover",onOver,true);document.addEventListener("pointerout",onOut,true);document.addEventListener("pointermove",onMove,true);
  document.addEventListener("keydown",e=>{if(viewer.key(e)){e.preventDefault();e.stopPropagation()}},true);
  document.addEventListener("click",e=>{if(settings.activationMode!=="click")return;const a=(e.target as Element).closest?.("a[href]") as HTMLAnchorElement|null;if(!a)return;e.preventDefault();activate(a,e.clientX,e.clientY)},true);
  if(settings.prefetch!=="off")requestIdleCallback(()=>prefetchVisible(),{timeout:2500});
}
function cancelActiveScan(){
  if(!activeScan)return;
  chrome.runtime.sendMessage({type:"LINKPEEK_CANCEL_SCAN",url:activeScan.url,token:activeScan.token}).catch(()=>{});
  activeScan=undefined;
}
function onOver(e:PointerEvent){
  lastPointerX=e.clientX;lastPointerY=e.clientY;if(settings.activationMode==="click")return;
  const a=(e.target as Element).closest?.("a[href]") as HTMLAnchorElement|null;if(!a||a===currentAnchor)return;
  currentAnchor=a;startX=e.clientX;startY=e.clientY;
  if(settings.activationMode==="modifier"&&!e.altKey)return;
  clear();const eff=effectiveSettings(settings,a.href);if(!eff.enabled)return;
  const kind=classifyLink(a.href);if(["anchor","download","ignored"].includes(kind))return;
  hoverTimer=window.setTimeout(()=>activate(a,e.clientX,e.clientY),eff.hoverDelay);
}
function onMove(e:PointerEvent){
  lastPointerX=e.clientX;lastPointerY=e.clientY;if(!currentAnchor)return;
  const eff=effectiveSettings(settings,currentAnchor.href);
  if(settings.activationMode==="modifier"&&e.altKey&&!hoverTimer){
    startX=e.clientX;startY=e.clientY;hoverTimer=window.setTimeout(()=>currentAnchor&&activate(currentAnchor,e.clientX,e.clientY),eff.hoverDelay);return;
  }
  if(!hoverTimer)return;
  if(Math.hypot(e.clientX-startX,e.clientY-startY)>eff.cancelMovePx){clearTimeout(hoverTimer);hoverTimer=undefined}
}
function onOut(e:PointerEvent){
  const a=(e.target as Element).closest?.("a[href]") as HTMLAnchorElement|null;if(!a||a!==currentAnchor)return;
  const to=e.relatedTarget as Node|null;if(to&&viewer.host.contains(to))return;
  clear();if(!viewer.pinned){requestId++;cancelActiveScan();viewer.closeTimer=window.setTimeout(()=>viewer.close(),effectiveSettings(settings,a.href).closeDelay)}
  currentAnchor=null;
}
function clear(){if(hoverTimer)clearTimeout(hoverTimer);hoverTimer=undefined}
async function activate(a:HTMLAnchorElement,x:number,y:number){
  clear();cancelActiveScan();
  const id=++requestId,eff=effectiveSettings(settings,a.href),kind=classifyLink(a.href),token=`${Date.now()}-${id}-${Math.random().toString(36).slice(2)}`;
  activeScan={url:a.href,token};viewer.openLoading(x,y,eff,a.textContent?.trim().slice(0,80)||"Scanning link…");
  try{
    const result=await chrome.runtime.sendMessage({type:"LINKPEEK_SCAN",url:a.href,kind,token}) as ScanResult&{error?:string;cancelled?:boolean};
    if(id!==requestId||activeScan?.token!==token)return;if(result.cancelled)return;if(result.error)throw new Error(result.error);viewer.show(result);
  }catch(err){if(id===requestId&&activeScan?.token===token)viewer.error(err instanceof Error?err.message:String(err))}
  finally{if(activeScan?.token===token)activeScan=undefined}
}
function prefetchVisible(){
  if(!settings.enabled||settings.prefetch==="off")return;
  const candidates=[...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map(a=>{
    const r=a.getBoundingClientRect(),kind=classifyLink(a.href);
    if(kind!=="discourse"||r.bottom<-innerHeight||r.top>innerHeight*2||r.right<0||r.left>innerWidth)return null;
    const nearestX=Math.max(r.left,Math.min(lastPointerX,r.right)),nearestY=Math.max(r.top,Math.min(lastPointerY,r.bottom));
    return {a,kind,score:Math.hypot(lastPointerX-nearestX,lastPointerY-nearestY)};
  }).filter((x):x is NonNullable<typeof x>=>!!x).sort((a,b)=>a.score-b.score);
  const limit=settings.prefetch==="nearby"?2:settings.prefetch==="visible"?4:6,queue=candidates.slice(0,limit);let active=0,index=0;
  const next=()=>{
    while(active<2&&index<queue.length){
      const {a,kind}=queue[index++];if(prefetched.has(a.href))continue;prefetched.add(a.href);active++;
      chrome.runtime.sendMessage({type:"LINKPEEK_PREFETCH",url:a.href,kind}).finally(()=>{active--;next()});
    }
  };next();
}
boot();
