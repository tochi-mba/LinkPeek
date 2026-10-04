import {classifyLink,type ScanResult} from "./shared/media";
import {effectiveSettings,loadSettings,type LinkPeekSettings} from "./shared/settings";
import {Viewer} from "./ui/viewer";

let settings:LinkPeekSettings;const viewer=new Viewer();
let hoverTimer:number|undefined;let currentAnchor:HTMLAnchorElement|null=null;let requestId=0;let startX=0,startY=0;
const prefetched=new Set<string>();

async function boot(){
  settings=await loadSettings();
  chrome.storage.onChanged.addListener(async()=>{settings=await loadSettings()});
  document.addEventListener("pointerover",onOver,true);
  document.addEventListener("pointerout",onOut,true);
  document.addEventListener("pointermove",onMove,true);
  document.addEventListener("keydown",e=>{if(viewer.key(e)){e.preventDefault();e.stopPropagation()}},true);
  document.addEventListener("click",e=>{if(settings.activationMode!=="click")return;const a=(e.target as Element).closest?.("a[href]") as HTMLAnchorElement|null;if(!a)return;e.preventDefault();activate(a,e.clientX,e.clientY)},true);
  if(settings.prefetch!=="off")requestIdleCallback(()=>prefetchVisible(),{timeout:2500});
}
function onOver(e:PointerEvent){
  if(settings.activationMode==="click")return;
  const a=(e.target as Element).closest?.("a[href]") as HTMLAnchorElement|null;if(!a||a===currentAnchor)return;
  currentAnchor=a;startX=e.clientX;startY=e.clientY;
  if(settings.activationMode==="modifier"&&!e.altKey)return;
  clear();
  const eff=effectiveSettings(settings,a.href);if(!eff.enabled)return;
  const kind=classifyLink(a.href);if(["anchor","download","ignored"].includes(kind))return;
  hoverTimer=window.setTimeout(()=>activate(a,e.clientX,e.clientY),eff.hoverDelay);
}
function onMove(e:PointerEvent){
  if(!currentAnchor)return;
  const eff=effectiveSettings(settings,currentAnchor.href);
  if(settings.activationMode==="modifier"&&e.altKey&&!hoverTimer){
    startX=e.clientX;startY=e.clientY;
    hoverTimer=window.setTimeout(()=>currentAnchor&&activate(currentAnchor,e.clientX,e.clientY),eff.hoverDelay);
    return;
  }
  if(!hoverTimer)return;
  if(Math.hypot(e.clientX-startX,e.clientY-startY)>eff.cancelMovePx){clearTimeout(hoverTimer);hoverTimer=undefined}
}
function onOut(e:PointerEvent){
  const a=(e.target as Element).closest?.("a[href]") as HTMLAnchorElement|null;if(!a||a!==currentAnchor)return;
  const to=e.relatedTarget as Node|null;
  if(to&&viewer.host.contains(to))return;
  clear();
  if(!viewer.pinned){requestId++;viewer.closeTimer=window.setTimeout(()=>viewer.close(),effectiveSettings(settings,a.href).closeDelay)}
  currentAnchor=null;
}
function clear(){if(hoverTimer)clearTimeout(hoverTimer);hoverTimer=undefined}
async function activate(a:HTMLAnchorElement,x:number,y:number){
  clear();const id=++requestId;const eff=effectiveSettings(settings,a.href);const kind=classifyLink(a.href);
  viewer.openLoading(x,y,eff,a.textContent?.trim().slice(0,80)||"Scanning link…");
  try{
    const result=await chrome.runtime.sendMessage({type:"LINKPEEK_SCAN",url:a.href,kind}) as ScanResult&{error?:string};
    if(id!==requestId)return;if(result.error)throw new Error(result.error);viewer.show(result);
  }catch(err){if(id===requestId)viewer.error(err instanceof Error?err.message:String(err))}
}
function prefetchVisible(){
  if(!settings.enabled||settings.prefetch==="off")return;
  const anchors=[...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(a=>{
    const r=a.getBoundingClientRect();return r.bottom>-innerHeight&&r.top<innerHeight*2&&r.right>0&&r.left<innerWidth;
  }).slice(0,settings.prefetch==="nearby"?12:settings.prefetch==="visible"?30:60);
  let active=0,index=0;
  const next=()=>{
    while(active<Math.max(1,settings.maxRequests)&&index<anchors.length){
      const a=anchors[index++],kind=classifyLink(a.href);
      if(prefetched.has(a.href)||["anchor","download","ignored","generic"].includes(kind))continue;
      prefetched.add(a.href);active++;
      chrome.runtime.sendMessage({type:"LINKPEEK_PREFETCH",url:a.href,kind}).finally(()=>{active--;next()});
    }
  };next();
}
boot();
