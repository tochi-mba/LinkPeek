export type ActivationMode="hover"|"click"|"modifier";
export type ViewMode="focus"|"grid"|"filmstrip"|"masonry";
export type NavAxis="vertical"|"horizontal";
export type ThemeMode="rex"|"system"|"custom";

export interface LinkPeekSettings{
  enabled:boolean; activationMode:ActivationMode; hoverDelay:number; closeDelay:number;
  intentDetection:boolean; slowdownDetection:boolean; requirePointerStop:boolean; cancelMovePx:number;
  magneticBridge:boolean; magneticBridgeStrength:number; panelSize:"tiny"|"small"|"medium"|"large"|"custom";
  panelWidth:number; panelMaxVh:number; placement:"auto"|"right"|"left"|"above"|"below"; pointerGap:number;
  autoExpand:boolean; panelOpacity:number; inactiveOpacity:number; animationMs:number;
  defaultView:ViewMode; navAxis:NavAxis; snap:boolean; loopMode:"stop"|"resist"|"wrap";
  showCounter:boolean; showPostCounter:boolean; showFilename:boolean; showAuthor:boolean; showDimensions:boolean;
  groupByPost:boolean; sort:"thread"|"upload"|"largest"|"newest"; startAt:"first"|"linked"|"remember";
  verticalGesture:"navigate"|"pan"|"scroll"|"disabled"; horizontalGesture:"scrub"|"navigate"|"disabled";
  pinchZoom:boolean; doubleClick:"zoom"|"fullscreen"|"next"|"none"; navSensitivity:number; gestureThreshold:number;
  momentumFiltering:boolean; gestureCooldown:number; fastSwipeAcceleration:boolean; maxImagesPerSwipe:number;
  reverseVertical:boolean; reverseHorizontal:boolean; deliberateGesture:boolean; ignoreTinyMotion:boolean;
  fit:"contain"|"width"|"height"|"actual"; maxZoom:number; minZoom:number; pinchSensitivity:number;
  doubleClickZoom:number; secondDoubleClick:"fit"|"increase"; zoomCenter:"pointer"|"center";
  panWhenZoomed:boolean; panFriction:number; edgeResistance:boolean; edgeNext:boolean; edgeDwell:number;
  resetZoomPerImage:boolean; rememberZoom:boolean;
  includeImages:boolean; includeGif:boolean; includeWebp:boolean; includeAvif:boolean; includeSvg:boolean;
  includeVideoThumbs:boolean; includeAvatars:boolean; includeEmoji:boolean; minWidth:number; minHeight:number;
  minBytes:number; preferVersion:"original"|"largest"|"displayed"; thumbQuality:"auto"|"low"|"high";
  relevanceStrength:number; dedupe:boolean; quotedDuplicates:"hide"|"mark"|"show"; perceptualHash:boolean;
  scanScope:"whole"|"page"|"nearby"|"first"; maxPosts:number; progressiveScan:boolean; prioritizeLinkedPost:boolean;
  fetchDirection:"linked"|"start"|"end"; continueAfterClose:"no"|"brief"|"always"; cacheThreads:boolean;
  prefetch:"off"|"nearby"|"visible"|"all"; prefetchRadius:number; idlePrefetch:boolean; maxRequests:number;
  batchSize:number; networkMode:"adaptive"|"data"|"aggressive"; meteredOff:boolean; cacheMinutes:number;
  maxCacheMb:number; preloadNext:number; preloadOriginals:"never"|"next"|"three"|"aggressive";
  gifAutoplay:"focus"|"always"|"never"; videoAutoplay:boolean; videoMuted:boolean; videoLoopShort:boolean;
  theme:ThemeMode; customAccent:string; blur:number; transparency:number; imageBackground:"black"|"checker"|"theme"|"custom";
  thumbnailShape:"square"|"ratio"|"rounded"; thumbnailSize:number; density:"compact"|"comfortable"|"spacious";
  labels:"both"|"icons"|"text"; scrollbar:"normal"|"minimal"|"hidden"; motion:"full"|"reduced"|"none";
  shortcuts:Record<string,string[]>; mouseWheel:"navigate"|"scroll"|"zoom"; ctrlWheel:"zoom"|"browser";
  middleClick:"original"|"post"|"pin"; siteProfiles:Record<string,Partial<LinkPeekSettings>>;
  stripTracking:boolean; referrerPolicy:"default"|"same-origin"|"never"; clearCache:"close"|"daily"|"never";
  downloadOriginal:boolean; downloadPattern:string; downloadFolder:boolean; downloadMetadata:boolean;
  reducedMotion:boolean; highContrast:boolean; largeControls:boolean; minTextSize:number; alwaysShowControls:boolean;
  screenReader:boolean; announcePosition:boolean; announceLoaded:boolean; touchTarget:"normal"|"large"|"xl";
  fetchTimeout:number; retryCount:number; followRedirects:boolean; lazyDetection:boolean; srcsetLargest:boolean;
  stripFragments:boolean; canonicalizeQuery:boolean; mutationObserver:boolean; spaDetection:boolean;
  customIgnoreSelectors:string[]; customPreferredSelectors:string[]; onboardingComplete:boolean; showLearningTips:boolean;
  preset:"balanced"|"minimal"|"fast"|"touchpad"|"manual"|"custom";
}
export const DEFAULT_SETTINGS:LinkPeekSettings={
  enabled:true,activationMode:"hover",hoverDelay:300,closeDelay:180,intentDetection:true,slowdownDetection:true,requirePointerStop:false,cancelMovePx:18,
  magneticBridge:true,magneticBridgeStrength:0.7,panelSize:"medium",panelWidth:480,panelMaxVh:70,placement:"auto",pointerGap:12,autoExpand:true,panelOpacity:1,inactiveOpacity:.9,animationMs:180,
  defaultView:"focus",navAxis:"vertical",snap:true,loopMode:"resist",showCounter:true,showPostCounter:true,showFilename:false,showAuthor:true,showDimensions:false,groupByPost:true,sort:"thread",startAt:"linked",
  verticalGesture:"navigate",horizontalGesture:"scrub",pinchZoom:true,doubleClick:"zoom",navSensitivity:.55,gestureThreshold:62,momentumFiltering:true,gestureCooldown:140,fastSwipeAcceleration:true,maxImagesPerSwipe:3,
  reverseVertical:false,reverseHorizontal:false,deliberateGesture:true,ignoreTinyMotion:true,fit:"contain",maxZoom:8,minZoom:1,pinchSensitivity:1,doubleClickZoom:2,secondDoubleClick:"fit",zoomCenter:"pointer",
  panWhenZoomed:true,panFriction:.85,edgeResistance:true,edgeNext:true,edgeDwell:120,resetZoomPerImage:true,rememberZoom:false,
  includeImages:true,includeGif:true,includeWebp:true,includeAvif:true,includeSvg:false,includeVideoThumbs:true,includeAvatars:false,includeEmoji:false,minWidth:200,minHeight:160,minBytes:0,
  preferVersion:"original",thumbQuality:"auto",relevanceStrength:.7,dedupe:true,quotedDuplicates:"hide",perceptualHash:false,scanScope:"whole",maxPosts:2000,progressiveScan:true,prioritizeLinkedPost:true,fetchDirection:"linked",
  continueAfterClose:"brief",cacheThreads:true,prefetch:"nearby",prefetchRadius:1,idlePrefetch:true,maxRequests:3,batchSize:20,networkMode:"adaptive",meteredOff:true,cacheMinutes:60,maxCacheMb:250,preloadNext:3,preloadOriginals:"next",
  gifAutoplay:"focus",videoAutoplay:false,videoMuted:true,videoLoopShort:true,theme:"rex",customAccent:"#D7FF3F",blur:16,transparency:.08,imageBackground:"black",thumbnailShape:"ratio",thumbnailSize:120,density:"comfortable",
  labels:"both",scrollbar:"minimal",motion:"full",shortcuts:{next:["ArrowDown","ArrowRight"],previous:["ArrowUp","ArrowLeft"],close:["Escape"],pin:["p"],grid:["g"],focus:["f"],open:["o"],help:["?","/"],zoomIn:["+","="],zoomOut:["-"],resetZoom:["0"],download:["d"]},
  mouseWheel:"navigate",ctrlWheel:"zoom",middleClick:"original",siteProfiles:{},stripTracking:true,referrerPolicy:"same-origin",clearCache:"close",
  downloadOriginal:true,downloadPattern:"{thread}-{post}-{index}-{filename}",downloadFolder:true,downloadMetadata:false,reducedMotion:false,highContrast:false,largeControls:false,minTextSize:13,alwaysShowControls:false,
  screenReader:true,announcePosition:true,announceLoaded:true,touchTarget:"normal",fetchTimeout:8000,retryCount:2,followRedirects:true,lazyDetection:true,srcsetLargest:true,stripFragments:true,canonicalizeQuery:true,mutationObserver:true,spaDetection:true,
  customIgnoreSelectors:["header img","nav img",".avatar",".emoji",".badge"],customPreferredSelectors:[".cooked .lightbox","article img","main img"],onboardingComplete:false,showLearningTips:true,preset:"balanced"
};
export const PRESETS:Record<string,Partial<LinkPeekSettings>>={
  balanced:{hoverDelay:300,prefetch:"nearby",defaultView:"focus",motion:"full"},
  minimal:{hoverDelay:500,prefetch:"off",panelSize:"small",showAuthor:false,showLearningTips:false,motion:"reduced"},
  fast:{hoverDelay:120,prefetch:"visible",maxRequests:5,preloadNext:5,networkMode:"aggressive"},
  touchpad:{hoverDelay:220,verticalGesture:"navigate",horizontalGesture:"scrub",pinchZoom:true,doubleClick:"zoom",gestureThreshold:48,navSensitivity:.7},
  manual:{activationMode:"modifier",prefetch:"off",hoverDelay:0}
};
export async function loadSettings():Promise<LinkPeekSettings>{
  const stored=await chrome.storage.local.get("settings");
  return {...DEFAULT_SETTINGS,...(stored.settings??{}),shortcuts:{...DEFAULT_SETTINGS.shortcuts,...(stored.settings?.shortcuts??{})},siteProfiles:stored.settings?.siteProfiles??{}} as LinkPeekSettings;
}
export async function saveSettings(settings:LinkPeekSettings){await chrome.storage.local.set({settings});}
export function effectiveSettings(settings:LinkPeekSettings,url:string){
  const host=new URL(url).hostname;
  const override=settings.siteProfiles[host]??Object.entries(settings.siteProfiles).find(([k])=>k.startsWith("*.")&&host.endsWith(k.slice(1)))?.[1];
  return override?({...settings,...override} as LinkPeekSettings):settings;
}
