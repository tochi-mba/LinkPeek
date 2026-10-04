import {DEFAULT_SETTINGS,PRESETS,loadSettings,saveSettings,type LinkPeekSettings} from "../shared/settings";
type Primitive=string|number|boolean;
const categories=[
  ["General",["enabled","activationMode","defaultView","preset","onboardingComplete","showLearningTips"]],
  ["Hover & Activation",["hoverDelay","closeDelay","intentDetection","slowdownDetection","requirePointerStop","cancelMovePx","magneticBridge","magneticBridgeStrength"]],
  ["Panel",["panelSize","panelWidth","panelMaxVh","placement","pointerGap","autoExpand","panelOpacity","inactiveOpacity","animationMs"]],
  ["Gallery",["navAxis","snap","loopMode","showCounter","showPostCounter","showFilename","showAuthor","showDimensions","groupByPost","sort","startAt"]],
  ["Gestures",["verticalGesture","horizontalGesture","pinchZoom","doubleClick","navSensitivity","gestureThreshold","momentumFiltering","gestureCooldown","fastSwipeAcceleration","maxImagesPerSwipe","reverseVertical","reverseHorizontal","deliberateGesture","ignoreTinyMotion"]],
  ["Zoom & Pan",["fit","maxZoom","minZoom","pinchSensitivity","doubleClickZoom","secondDoubleClick","zoomCenter","panWhenZoomed","panFriction","edgeResistance","edgeNext","edgeDwell","resetZoomPerImage","rememberZoom"]],
  ["Media Detection",["includeImages","includeGif","includeWebp","includeAvif","includeSvg","includeVideoThumbs","includeAvatars","includeEmoji","minWidth","minHeight","minBytes","preferVersion","thumbQuality","relevanceStrength","dedupe","quotedDuplicates","perceptualHash","customIgnoreSelectors","customPreferredSelectors"]],
  ["Threads",["scanScope","maxPosts","progressiveScan","prioritizeLinkedPost","fetchDirection","continueAfterClose","cacheThreads"]],
  ["Prefetch & Performance",["prefetch","prefetchRadius","idlePrefetch","maxRequests","batchSize","networkMode","meteredOff","cacheMinutes","maxCacheMb","preloadNext","preloadOriginals"]],
  ["Media Types",["gifAutoplay","gifLoop","gifDefaultSpeed","gifPauseWhenHidden","gifDecodeMaxMb","gifControls","gifScrubWheel","gifFrameStepKeyboard","videoAutoplay","videoMuted","videoLoopShort"]],
  ["Appearance",["theme","customAccent","blur","transparency","imageBackground","thumbnailShape","thumbnailSize","density","labels","scrollbar","motion"]],
  ["Keyboard & Mouse",["shortcuts","mouseWheel","ctrlWheel","middleClick"]],
  ["Sites",["siteProfiles"]],
  ["Privacy",["stripTracking","referrerPolicy","clearCache"]],
  ["Downloads",["downloadOriginal","downloadPattern","downloadFolder","downloadMetadata"]],
  ["Accessibility",["reducedMotion","highContrast","largeControls","minTextSize","alwaysShowControls","screenReader","announcePosition","announceLoaded","touchTarget"]],
  ["Advanced",["fetchTimeout","retryCount","followRedirects","lazyDetection","srcsetLargest","stripFragments","canonicalizeQuery","mutationObserver","spaDetection"]]
] as const;
const choices:Record<string,string[]>={
  activationMode:["hover","click","modifier"],panelSize:["tiny","small","medium","large","custom"],placement:["auto","right","left","above","below"],defaultView:["focus","grid","filmstrip","masonry"],navAxis:["vertical","horizontal"],loopMode:["stop","resist","wrap"],sort:["thread","upload","largest","newest"],startAt:["first","linked","remember"],
  verticalGesture:["navigate","pan","scroll","disabled"],horizontalGesture:["scrub","navigate","disabled"],doubleClick:["zoom","fullscreen","next","none"],fit:["contain","width","height","actual"],secondDoubleClick:["fit","increase"],zoomCenter:["pointer","center"],preferVersion:["original","largest","displayed"],thumbQuality:["auto","low","high"],
  quotedDuplicates:["hide","mark","show"],scanScope:["whole","page","nearby","first"],fetchDirection:["linked","start","end"],continueAfterClose:["no","brief","always"],prefetch:["off","nearby","visible","all"],networkMode:["adaptive","data","aggressive"],preloadOriginals:["never","next","three","aggressive"],
  gifAutoplay:["focus","always","never"],gifControls:["always","hover","minimal"],theme:["rex","system","custom"],imageBackground:["black","checker","theme","custom"],thumbnailShape:["square","ratio","rounded"],density:["compact","comfortable","spacious"],labels:["both","icons","text"],scrollbar:["normal","minimal","hidden"],motion:["full","reduced","none"],
  mouseWheel:["navigate","scroll","zoom"],ctrlWheel:["zoom","browser"],middleClick:["original","post","pin"],referrerPolicy:["default","same-origin","never"],clearCache:["close","daily","never"],touchTarget:["normal","large","xl"]
};
const descriptions:Record<string,string>={
  hoverDelay:"Milliseconds before a hover becomes an intentional preview.",gifAutoplay:"Choose whether focused GIFs start playing automatically.",gifLoop:"Loop GIF playback at the final frame.",gifDefaultSpeed:"Initial GIF playback speed multiplier.",gifPauseWhenHidden:"Pause decoded GIF playback while the tab is hidden.",gifDecodeMaxMb:"Largest GIF LinkPeek will decode for frame controls; larger files fall back to native playback.",gifControls:"How prominently GIF playback controls stay visible.",gifScrubWheel:"Two-finger horizontal scrolling over the GIF timeline scrubs frames.",gifFrameStepKeyboard:"Enable comma/period frame stepping and bracket speed shortcuts.",gestureThreshold:"Trackpad movement required before one navigation step fires.",magneticBridgeStrength:"How forgiving the invisible bridge is when moving from the link into the panel.",relevanceStrength:"How strict generic-page media filtering should be.",batchSize:"Posts requested per Discourse batch.",siteProfiles:"JSON map of hostnames or wildcard hosts to setting overrides.",shortcuts:"JSON map of actions to one or more keys.",customIgnoreSelectors:"Selectors whose images should never count as content.",customPreferredSelectors:"Selectors that should be treated as high-confidence content."
};
let state:LinkPeekSettings;
const title=(k:string)=>k.replace(/([A-Z])/g," $1").replace(/^./,x=>x.toUpperCase());
const $=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b)}
function categoryModified(keys:readonly string[]){return keys.some(k=>!same((state as any)[k],(DEFAULT_SETTINGS as any)[k]))}
function control(key:string,value:any){
  if(typeof value==="boolean")return `<input type="checkbox" data-key="${key}" ${value?"checked":""}>`;
  if(choices[key])return `<select data-key="${key}">${choices[key].map(x=>`<option value="${x}" ${x===value?"selected":""}>${title(x)}</option>`).join("")}</select>`;
  if(typeof value==="number"){
    const range=/opacity|Strength|Sensitivity|Friction|transparency/i.test(key);if(range){const max=/opacity|transparency/i.test(key)?1:1;return `<input type="range" min="0" max="${max}" step=".05" value="${value}" data-key="${key}"><span class="value-num">${value}</span>`}
    return `<input type="number" value="${value}" data-key="${key}">`;
  }
  if(typeof value==="object")return `<textarea class="json" data-key="${key}">${escapeHtml(JSON.stringify(value,null,2))}</textarea>`;
  return `<input type="text" value="${escapeHtml(String(value))}" data-key="${key}">`;
}
function escapeHtml(v:string){return v.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!))}
function render(filter=""){
  const q=filter.trim().toLowerCase();$("nav").innerHTML=categories.map(([name])=>`<button data-jump="${name}">${name}</button>`).join("");
  $("sections").innerHTML=categories.map(([name,keys])=>{
    const visible=keys.filter(k=>!q||name.toLowerCase().includes(q)||title(k).toLowerCase().includes(q)||(descriptions[k]||"").toLowerCase().includes(q));if(!visible.length)return "";
    return `<section class="section card" data-section="${name}"><div class="section-head"><h2>${name}</h2>${categoryModified(keys)?'<span class="modified" title="Modified"></span>':""}<span class="spacer"></span><button class="reset" data-reset-section="${name}">Reset section ↺</button></div>${visible.map(k=>`<label class="field"><span><strong>${title(k)}</strong><small>${descriptions[k]||""}</small></span><span class="field-control">${control(k,(state as any)[k])}${!same((state as any)[k],(DEFAULT_SETTINGS as any)[k])?`<button class="reset" data-reset="${k}">↺</button>`:""}</span></label>`).join("")}</section>`;
  }).join("");
  bind();
}
function bind(){
  document.querySelectorAll<HTMLElement>("[data-key]").forEach(el=>el.addEventListener("change",async()=>{
    const key=el.dataset.key!;let v:any;
    if(el instanceof HTMLInputElement&&el.type==="checkbox")v=el.checked;
    else if(el instanceof HTMLInputElement&&el.type==="number")v=Number(el.value);
    else if(el instanceof HTMLInputElement&&el.type==="range")v=Number(el.value);
    else if(el instanceof HTMLTextAreaElement){try{v=JSON.parse(el.value)}catch{el.style.borderColor="var(--live)";return}}
    else v=(el as HTMLInputElement|HTMLSelectElement).value;
    (state as any)[key]=v;if(key!=="preset")state.preset="custom";await persist();render(($("search") as HTMLInputElement).value);
  }));
  document.querySelectorAll<HTMLElement>("[data-reset]").forEach(b=>b.addEventListener("click",async()=>{const k=b.dataset.reset!;(state as any)[k]=(DEFAULT_SETTINGS as any)[k];await persist();render(($("search") as HTMLInputElement).value)}));
  document.querySelectorAll<HTMLElement>("[data-reset-section]").forEach(b=>b.addEventListener("click",async()=>{const cat=categories.find(x=>x[0]===b.dataset.resetSection);cat?.[1].forEach(k=>(state as any)[k]=(DEFAULT_SETTINGS as any)[k]);await persist();render(($("search") as HTMLInputElement).value)}));
  document.querySelectorAll<HTMLElement>("[data-jump]").forEach(b=>b.addEventListener("click",()=>document.querySelector(`[data-section="${b.dataset.jump}"]`)?.scrollIntoView({behavior:"smooth"})));
}
async function persist(){await saveSettings(state);$("saved").textContent="Saved";setTimeout(()=>$("saved").textContent="",900)}
(async()=>{state=await loadSettings();$("presets").innerHTML=Object.keys(PRESETS).map(p=>`<button class="button ${state.preset===p?"active":""}" data-preset="${p}">${title(p)}</button>`).join("");document.querySelectorAll<HTMLElement>("[data-preset]").forEach(b=>b.onclick=async()=>{const p=b.dataset.preset!;state={...state,...PRESETS[p],preset:p as LinkPeekSettings["preset"]};await persist();location.reload()});render()})();
$("search").addEventListener("input",e=>render((e.target as HTMLInputElement).value));
$("tutorial").addEventListener("click",()=>location.href=chrome.runtime.getURL("onboarding.html"));
