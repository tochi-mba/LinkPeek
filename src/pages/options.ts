import {DEFAULT_SETTINGS,PRESETS,loadSettings,saveSettings,type LinkPeekSettings} from "../shared/settings";
type Primitive=string|number|boolean;
const categories=[
  ["General",["enabled","activationMode","defaultView","preset","onboardingComplete","showLearningTips"]],
  ["Hover & Activation",["hoverDelay","closeDelay","intentDetection","slowdownDetection","requirePointerStop","cancelMovePx","magneticBridge","magneticBridgeStrength"]],
  ["Panel",["panelSize","panelWidth","panelMaxVh","focusHeightVh","expandedWidthVw","expandedHeightVh","startExpanded","quickViewControls","draggablePanel","resizablePanel","rememberPanelGeometry","placement","pointerGap","autoExpand","panelOpacity","inactiveOpacity","animationMs"]],
  ["Gallery",["navAxis","snap","loopMode","showCounter","showPostCounter","showFilename","showAuthor","showDimensions","groupByPost","sort","startAt"]],
  ["Gestures",["verticalGesture","horizontalGesture","pinchZoom","doubleClick","navSensitivity","gestureThreshold","momentumFiltering","gestureCooldown","fastSwipeAcceleration","maxImagesPerSwipe","reverseVertical","reverseHorizontal","deliberateGesture","ignoreTinyMotion"]],
  ["Zoom & Pan",["fit","maxZoom","minZoom","pinchSensitivity","doubleClickZoom","secondDoubleClick","zoomCenter","doubleClickDragPan","panWhenZoomed","panFriction","edgeResistance","edgeNext","edgeDwell","resetZoomPerImage","rememberZoom"]],
  ["Media Detection",["includeImages","includeGif","includeWebp","includeAvif","includeSvg","includeVideoThumbs","includeAvatars","includeEmoji","minWidth","minHeight","minBytes","preferVersion","thumbQuality","relevanceStrength","dedupe","quotedDuplicates","perceptualHash","customIgnoreSelectors","customPreferredSelectors"]],
  ["Linked-page Fallback",["recursiveSearch","recursiveTrigger","recursiveMaxDepth","recursiveMaxPages","maxMediaItems"]],
  ["Threads",["scanScope","maxPosts","progressiveScan","prioritizeLinkedPost","fetchDirection","continueAfterClose","cacheThreads"]],
  ["Prefetch & Performance",["prefetch","prefetchRadius","idlePrefetch","maxRequests","batchSize","networkMode","meteredOff","cacheMinutes","maxCacheMb","preloadNext","preloadPrevious","preloadConcurrency","preloadMemoryMb","preloadRest","preloadRestLimit","preloadOriginals"]],
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
  quotedDuplicates:["hide","mark","show"],recursiveSearch:["off","same-origin","all"],recursiveTrigger:["empty","always"],scanScope:["whole","page","nearby","first"],fetchDirection:["linked","start","end"],continueAfterClose:["no","brief","always"],prefetch:["off","nearby","visible","all"],networkMode:["adaptive","data","aggressive"],preloadRest:["off","idle","all"],preloadOriginals:["never","next","three","aggressive"],
  gifAutoplay:["focus","always","never"],gifControls:["always","hover","minimal"],theme:["rex","system","custom"],imageBackground:["black","checker","theme","custom"],thumbnailShape:["square","ratio","rounded"],density:["compact","comfortable","spacious"],labels:["both","icons","text"],scrollbar:["normal","minimal","hidden"],motion:["full","reduced","none"],
  mouseWheel:["navigate","scroll","zoom"],ctrlWheel:["zoom","browser"],middleClick:["original","post","pin"],referrerPolicy:["default","same-origin","never"],clearCache:["close","daily","never"],touchTarget:["normal","large","xl"]
};
const descriptions:Record<string,string>={
  hoverDelay:"Milliseconds before a hover becomes an intentional preview.",
  prefetch:"Warm likely links before you hover them. Nearby is the recommended balance.",
  prefetchRadius:"How far around the current viewport LinkPeek considers links for prefetching.",
  idlePrefetch:"Only prefetch when the page/browser has spare time.",
  maxRequests:"Maximum simultaneous LinkPeek network requests.",
  batchSize:"Posts requested per Discourse batch. Larger batches reduce round trips.",
  networkMode:"Adaptive balances responsiveness and bandwidth; Data Saver is conservative; Aggressive favors speed.",
  meteredOff:"Disable background prefetch when the browser reports a constrained connection.",
  cacheMinutes:"How long completed thread scans stay reusable before expiring.",
  maxCacheMb:"Maximum approximate LinkPeek result-cache memory budget.",
  preloadNext:"How many upcoming media items to decode before you reach them.",
  preloadPrevious:"How many previous media items to keep decoded for instant back-navigation.",
  preloadConcurrency:"Maximum simultaneous media preload/decode jobs.",
  preloadMemoryMb:"Approximate decoded-image memory budget for the focus-view preload ring.",
  preloadRest:"After nearby media is ready, optionally preload the rest of the gallery in idle time or immediately.",
  preloadRestLimit:"Only idle-preload the full gallery when it has at most this many items. The 120-item default makes large grids fast while the memory cap prevents runaway decoding. Use 0 for no item-count limit.",
  preloadOriginals:"Choose when full-resolution originals are prepared instead of previews.",
  recursiveSearch:"Choose which linked pages fallback may inspect. Same site is the recommended privacy-safe mode.",
  recursiveTrigger:"Choose whether linked pages are searched only when no media is found, or on every generic page.",
  recursiveMaxDepth:"Maximum number of link levels followed after the opened page.",
  recursiveMaxPages:"Maximum total pages read for one fallback search, including the opened page.",
  maxMediaItems:"Maximum unique media items kept in any gallery, including forum threads.",
  focusHeightVh:"Height of the normal focus viewer as a percentage of the browser viewport.",
  expandedWidthVw:"Width used by the quick Expand control.",
  expandedHeightVh:"Height used by the quick Expand control.",
  startExpanded:"Open media viewers in the expanded layout by default.",
  quickViewControls:"Show quick Expand and grid-density controls directly in the viewer.",
  draggablePanel:"Drag the viewer by its header to place it anywhere in the viewport.",
  resizablePanel:"Resize the viewer from any edge or corner.",
  rememberPanelGeometry:"Reuse your last dragged position and size for future previews.",
  doubleClickDragPan:"When zoomed, double-click-and-hold then drag to pan the media directly.",
  gifAutoplay:"Choose whether focused GIFs start playing automatically.",gifLoop:"Loop GIF playback at the final frame.",gifDefaultSpeed:"Initial GIF playback speed multiplier.",gifPauseWhenHidden:"Pause decoded GIF playback while the tab is hidden.",gifDecodeMaxMb:"Largest GIF LinkPeek will decode for frame controls; larger files fall back to native playback.",gifControls:"How prominently GIF playback controls stay visible.",gifScrubWheel:"Two-finger horizontal scrolling over the GIF timeline scrubs frames.",gifFrameStepKeyboard:"Enable comma/period frame stepping and bracket speed shortcuts.",gestureThreshold:"Trackpad movement required before one navigation step fires.",magneticBridgeStrength:"How forgiving the invisible bridge is when moving from the link into the panel.",relevanceStrength:"How strict generic-page media filtering should be.",siteProfiles:"JSON map of hostnames or wildcard hosts to setting overrides.",shortcuts:"JSON map of actions to one or more keys.",customIgnoreSelectors:"Selectors whose images should never count as content.",customPreferredSelectors:"Selectors that should be treated as high-confidence content."
};
const choiceLabels:Record<string,Record<string,string>>={
  prefetch:{off:"Off",nearby:"Nearby",visible:"Visible",all:"All visible links"},
  networkMode:{adaptive:"Adaptive",data:"Data Saver",aggressive:"Aggressive"},
  preloadRest:{off:"Nearby only",idle:"Whole gallery when idle",all:"Whole gallery immediately"},
  preloadOriginals:{never:"Never",next:"Next",three:"Next 3",aggressive:"Aggressive"},
  activationMode:{hover:"Hover",click:"Click",modifier:"Modifier + hover"},
  continueAfterClose:{no:"Stop",brief:"Briefly",always:"Always"},
  recursiveSearch:{off:"Off","same-origin":"Same site",all:"Any site"},
  recursiveTrigger:{empty:"No media found",always:"Always"}
};
const segmentedKeys=new Set(["prefetch"]);
const numberMeta:Record<string,{min?:number;max?:number;step?:number;unit?:string}>={
  hoverDelay:{min:0,max:2000,step:25,unit:"ms"},closeDelay:{min:0,max:2000,step:25,unit:"ms"},
  prefetchRadius:{min:0,max:6,step:1},maxRequests:{min:1,max:12,step:1},batchSize:{min:10,max:100,step:10},
  cacheMinutes:{min:1,max:1440,step:5,unit:"min"},maxCacheMb:{min:16,max:2048,step:16,unit:"MB"},preloadNext:{min:0,max:30,step:1},preloadPrevious:{min:0,max:20,step:1},preloadConcurrency:{min:1,max:8,step:1},preloadMemoryMb:{min:32,max:1024,step:16,unit:"MB"},preloadRestLimit:{min:0,max:5000,step:10},
  maxPosts:{min:20,max:10000,step:20},gifDecodeMaxMb:{min:1,max:100,step:1,unit:"MB"},
  maxMediaItems:{min:1,max:5000,step:25},recursiveMaxDepth:{min:1,max:3,step:1},recursiveMaxPages:{min:1,max:50,step:1},
  panelWidth:{min:280,max:1600,step:10,unit:"px"},panelMaxVh:{min:40,max:98,step:1,unit:"vh"},focusHeightVh:{min:30,max:90,step:1,unit:"vh"},expandedWidthVw:{min:50,max:98,step:1,unit:"vw"},expandedHeightVh:{min:50,max:98,step:1,unit:"vh"},pointerGap:{min:0,max:48,step:1,unit:"px"},
  animationMs:{min:0,max:1000,step:10,unit:"ms"},fetchTimeout:{min:500,max:30000,step:500,unit:"ms"},
  retryCount:{min:0,max:10,step:1},thumbnailSize:{min:48,max:320,step:4,unit:"px"}
};
let state:LinkPeekSettings;
const title=(k:string)=>k.replace(/([A-Z])/g," $1").replace(/^./,x=>x.toUpperCase());
const $=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b)}
function categoryModified(keys:readonly string[]){return keys.some(k=>!same((state as any)[k],(DEFAULT_SETTINGS as any)[k]))}
function choiceLabel(key:string,value:string){return choiceLabels[key]?.[value]??title(value)}
function control(key:string,value:any){
  if(typeof value==="boolean")return `<label class="switch"><input type="checkbox" data-key="${key}" ${value?"checked":""}><span class="switch-track"><span class="switch-thumb"></span></span></label>`;
  if(choices[key]){
    if(segmentedKeys.has(key))return `<div class="segmented" role="radiogroup" aria-label="${title(key)}">${choices[key].map(x=>`<button type="button" class="segment ${x===value?"active":""}" data-choice-key="${key}" data-choice-value="${x}" aria-pressed="${x===value}">${choiceLabel(key,x)}</button>`).join("")}</div>`;
    return `<span class="select-shell"><select data-key="${key}" aria-label="${title(key)}">${choices[key].map(x=>`<option value="${x}" ${x===value?"selected":""}>${choiceLabel(key,x)}</option>`).join("")}</select><span class="select-chevron">⌄</span></span>`;
  }
  if(typeof value==="number"){
    const range=/opacity|Strength|Sensitivity|Friction|transparency/i.test(key);if(range){const max=/opacity|transparency/i.test(key)?1:1;return `<div class="range-control"><input type="range" min="0" max="${max}" step=".05" value="${value}" data-key="${key}"><span class="value-num">${value}</span></div>`}
    const meta=numberMeta[key]??{},attrs=[meta.min!=null?`min="${meta.min}"`:"",meta.max!=null?`max="${meta.max}"`:"",meta.step!=null?`step="${meta.step}"`:""].filter(Boolean).join(" ");
    return `<div class="number-shell"><button type="button" class="number-step" data-step-key="${key}" data-step-dir="-1" aria-label="Decrease ${title(key)}">−</button><input type="number" value="${value}" data-key="${key}" ${attrs}><button type="button" class="number-step" data-step-key="${key}" data-step-dir="1" aria-label="Increase ${title(key)}">+</button>${meta.unit?`<span class="number-unit">${meta.unit}</span>`:""}</div>`;
  }
  if(typeof value==="object")return `<textarea class="json" data-key="${key}">${escapeHtml(JSON.stringify(value,null,2))}</textarea>`;
  return `<input type="text" value="${escapeHtml(String(value))}" data-key="${key}">`;
}
function escapeHtml(v:string){return v.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!))}
function render(filter=""){
  const q=filter.trim().toLowerCase();$("nav").innerHTML=categories.map(([name])=>`<button data-jump="${name}">${name}</button>`).join("");
  $("sections").innerHTML=categories.map(([name,keys])=>{
    const visible=keys.filter(k=>!q||name.toLowerCase().includes(q)||title(k).toLowerCase().includes(q)||(descriptions[k]||"").toLowerCase().includes(q));if(!visible.length)return "";
    const open=q||["General","Hover & Activation","Gestures","Linked-page Fallback","Prefetch & Performance"].includes(name);
    return `<details class="section card" data-section="${name}" ${open?"open":""}><summary class="section-head"><h2>${name}</h2>${categoryModified(keys)?'<span class="modified" title="Modified"></span>':""}<span class="spacer"></span><span class="section-count">${visible.length}</span></summary><div class="section-body">${visible.map(k=>`<label class="field"><span><strong>${title(k)}</strong><small>${descriptions[k]||""}</small></span><span class="field-control">${control(k,(state as any)[k])}<button class="reset" data-reset="${k}" ${same((state as any)[k],(DEFAULT_SETTINGS as any)[k])?"hidden":""}>↺</button></span></label>`).join("")}<button class="reset section-reset" data-reset-section="${name}">Reset this section ↺</button></div></details>`;
  }).join("");
  bind();
}
function rerenderKeepingSections(){
  const open=new Set([...document.querySelectorAll<HTMLDetailsElement>("details[data-section][open]")].map(x=>x.dataset.section));
  render($<HTMLInputElement>("search").value);
  document.querySelectorAll<HTMLDetailsElement>("details[data-section]").forEach(x=>{if(open.has(x.dataset.section))x.open=true});
}
function bind(){
  document.querySelectorAll<HTMLElement>("[data-choice-key]").forEach(el=>el.addEventListener("click",async()=>{
    const key=el.dataset.choiceKey!,v=el.dataset.choiceValue!;(state as any)[key]=v;if(key!=="preset")state.preset="custom";
    el.parentElement?.querySelectorAll<HTMLElement>("[data-choice-key]").forEach(x=>{const active=x===el;x.classList.toggle("active",active);x.setAttribute("aria-pressed",String(active))});el.closest(".field")?.querySelector<HTMLElement>("[data-reset]")?.toggleAttribute("hidden",same((state as any)[key],(DEFAULT_SETTINGS as any)[key]));await persist();
  }));
  document.querySelectorAll<HTMLElement>("[data-step-key]").forEach(el=>el.addEventListener("click",async()=>{
    const key=el.dataset.stepKey!,dir=Number(el.dataset.stepDir||0),meta=numberMeta[key]??{},current=Number((state as any)[key]),step=meta.step??1;
    const next=Math.min(meta.max??Infinity,Math.max(meta.min??-Infinity,current+dir*step));(state as any)[key]=next;state.preset="custom";const input=el.parentElement?.querySelector<HTMLInputElement>(`[data-key="${key}"]`);if(input)input.value=String(next);el.closest(".field")?.querySelector<HTMLElement>("[data-reset]")?.toggleAttribute("hidden",same(next,(DEFAULT_SETTINGS as any)[key]));await persist();
  }));
  document.querySelectorAll<HTMLElement>("[data-key]").forEach(el=>el.addEventListener("change",async()=>{
    const key=el.dataset.key!;let v:any;
    if(el instanceof HTMLInputElement&&el.type==="checkbox")v=el.checked;
    else if(el instanceof HTMLInputElement&&el.type==="number")v=Number(el.value);
    else if(el instanceof HTMLInputElement&&el.type==="range")v=Number(el.value);
    else if(el instanceof HTMLTextAreaElement){try{v=JSON.parse(el.value)}catch{el.style.borderColor="var(--live)";return}}
    else v=(el as HTMLInputElement|HTMLSelectElement).value;
    (state as any)[key]=v;if(key!=="preset")state.preset="custom";el.closest(".field")?.querySelector<HTMLElement>("[data-reset]")?.toggleAttribute("hidden",same(v,(DEFAULT_SETTINGS as any)[key]));await persist();
  }));
  document.querySelectorAll<HTMLInputElement>('input[type="range"][data-key]').forEach(el=>el.addEventListener("input",()=>{const value=el.parentElement?.querySelector<HTMLElement>(".value-num");if(value)value.textContent=el.value}));
  document.querySelectorAll<HTMLElement>("[data-reset]").forEach(b=>b.addEventListener("click",async()=>{const k=b.dataset.reset!;(state as any)[k]=(DEFAULT_SETTINGS as any)[k];state.preset="custom";await persist();rerenderKeepingSections()}));
  document.querySelectorAll<HTMLElement>("[data-reset-section]").forEach(b=>b.addEventListener("click",async()=>{const cat=categories.find(x=>x[0]===b.dataset.resetSection);cat?.[1].forEach(k=>(state as any)[k]=(DEFAULT_SETTINGS as any)[k]);state.preset="custom";await persist();rerenderKeepingSections()}));
  document.querySelectorAll<HTMLElement>("[data-jump]").forEach(b=>b.addEventListener("click",()=>{const section=document.querySelector<HTMLDetailsElement>(`[data-section="${b.dataset.jump}"]`);if(section){section.open=true;section.scrollIntoView({behavior:"smooth"})}}));
}
async function persist(){await saveSettings(state);$("saved").textContent="Saved";setTimeout(()=>$("saved").textContent="",900)}
(async()=>{state=await loadSettings();const presetLabels:Record<string,string>={balanced:"Balanced",minimal:"Data saver",fast:"Fast",touchpad:"Touchpad",manual:"Manual"};$("presets").innerHTML=Object.keys(PRESETS).map(p=>`<button class="button ${state.preset===p?"active":""}" data-preset="${p}">${presetLabels[p]}</button>`).join("");document.querySelectorAll<HTMLElement>("[data-preset]").forEach(b=>b.onclick=async()=>{const p=b.dataset.preset!;state={...state,...PRESETS[p],preset:p as LinkPeekSettings["preset"]};await persist();location.reload()});render()})();
$("search").addEventListener("input",e=>render((e.target as HTMLInputElement).value));
$("tutorial").addEventListener("click",()=>location.href=chrome.runtime.getURL("onboarding.html"));
