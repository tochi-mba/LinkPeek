import {prefetchDiscourse,scanDiscourse,type DiscourseSeed} from "./core/discourse";
import {scanGeneric} from "./core/generic";
import {DEFAULT_SETTINGS,effectiveSettings,loadSettings,type LinkPeekSettings} from "./shared/settings";
import type {ScanResult} from "./shared/media";

type CacheEntry={at:number;bytes:number;result:ScanResult;discourseSeed?:DiscourseSeed};
type Consumer={token:string;tabId?:number;frameId?:number};
type ScanTask={controller:AbortController;consumers:Map<string,Consumer>;promise:Promise<ScanResult>};

const cache=new Map<string,CacheEntry>();let cacheBytes=0;
const tasks=new Map<string,ScanTask>(),prefetchTasks=new Map<string,Promise<ScanResult|null>>();

function bytesToBase64(buffer:ArrayBuffer){
  const bytes=new Uint8Array(buffer);let binary="";const size=0x8000;
  for(let i=0;i<bytes.length;i+=size)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+size,bytes.length)));
  return btoa(binary);
}
function estimateBytes(result:ScanResult,seed?:DiscourseSeed){
  try{return new TextEncoder().encode(JSON.stringify(seed?{result,seed}:{result})).byteLength}catch{return result.items.length*256+1024}
}
function removeCache(url:string){
  const entry=cache.get(url);if(!entry)return;cache.delete(url);cacheBytes=Math.max(0,cacheBytes-entry.bytes);
}
function cachedEntry(url:string,settings:LinkPeekSettings){
  const entry=cache.get(url);if(!entry)return undefined;
  if(Date.now()-entry.at>=settings.cacheMinutes*60_000){removeCache(url);return undefined}
  cache.delete(url);cache.set(url,entry);return entry;
}
function putCache(url:string,result:ScanResult,settings:LinkPeekSettings,discourseSeed?:DiscourseSeed){
  removeCache(url);
  const bytes=estimateBytes(result,discourseSeed),limit=Math.max(1,settings.maxCacheMb)*1024*1024;
  if(bytes>limit)return;
  cache.set(url,{at:Date.now(),bytes,result,discourseSeed});cacheBytes+=bytes;
  while(cacheBytes>limit&&cache.size){
    const oldest=cache.keys().next().value as string|undefined;if(!oldest)break;removeCache(oldest);
  }
}
function directResult(url:string):ScanResult{
  return {url,kind:"direct-image",items:[{id:url,type:/\.gif/i.test(url)?"gif":"image",originalUrl:url,previewUrl:url,sourceUrl:url,score:1}],complete:true,diagnostics:{adapter:"Direct media",ignored:0,duplicates:0,warnings:[]}};
}
function addConsumer(task:ScanTask,msg:any,sender:chrome.runtime.MessageSender){
  const token=String(msg.token||`${Date.now()}-${Math.random().toString(36).slice(2)}`);
  task.consumers.set(token,{token,tabId:sender.tab?.id,frameId:sender.frameId});return token;
}
function broadcast(task:ScanTask,url:string,result:ScanResult){
  for(const c of task.consumers.values()){
    if(c.tabId==null)continue;
    chrome.tabs.sendMessage(c.tabId,{type:"LINKPEEK_SCAN_PROGRESS",token:c.token,url,result},{frameId:c.frameId??0}).catch(()=>{});
  }
}
async function executeScan(url:string,kind:string,settings:LinkPeekSettings,task:ScanTask,seed?:DiscourseSeed){
  let result:ScanResult;
  if(kind==="discourse"){
    let progressTimer:ReturnType<typeof setTimeout>|undefined,pendingProgress:ScanResult|undefined,progressStarted=false;
    const onProgress=settings.progressiveScan?(progress:ScanResult)=>{
      if(progressStarted){broadcast(task,url,progress);return}
      pendingProgress=progress;
      if(!progressTimer)progressTimer=setTimeout(()=>{progressTimer=undefined;progressStarted=true;if(pendingProgress)broadcast(task,url,pendingProgress)},70);
    }:undefined;
    try{
      result=await scanDiscourse(url,settings.batchSize,settings.maxPosts,settings,seed,{signal:task.controller.signal,onProgress});
    }finally{if(progressTimer)clearTimeout(progressTimer)}
  }else if(kind==="direct-image")result=directResult(url);
  else result=await scanGeneric(url,settings,task.controller.signal);
  if(settings.cacheThreads)putCache(url,result,settings);
  return result;
}
async function shallowPrefetch(url:string,kind:string,settings:LinkPeekSettings){
  const existing=cachedEntry(url,settings);if(existing)return existing.result;
  if(kind!=="discourse"){
    if(kind==="direct-image"){const result=directResult(url);putCache(url,result,settings);return result}
    return null;
  }
  const pending=prefetchTasks.get(url);if(pending)return pending;
  const promise=prefetchDiscourse(url,settings).then(({result,seed})=>{putCache(url,result,settings,seed);return result}).finally(()=>prefetchTasks.delete(url));
  prefetchTasks.set(url,promise);return promise;
}

chrome.runtime.onInstalled.addListener(async details=>{
  if(details.reason==="install"){
    await chrome.storage.local.set({settings:DEFAULT_SETTINGS});
    chrome.tabs.create({url:chrome.runtime.getURL("onboarding.html")});
  }
});

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg?.type==="LINKPEEK_PREFETCH"){
    (async()=>{
      const global=await loadSettings(),settings=effectiveSettings(global,msg.url);
      return shallowPrefetch(msg.url,msg.kind,settings);
    })().then(sendResponse).catch((e:Error)=>sendResponse({error:e.message}));
    return true;
  }
  if(msg?.type==="LINKPEEK_SCAN"){
    (async()=>{
      const global=await loadSettings(),settings=effectiveSettings(global,msg.url);
      const warm=prefetchTasks.get(msg.url);if(warm)await warm.catch(()=>null);
      const cached=cachedEntry(msg.url,settings);
      if(cached?.result.complete)return cached.result;
      let task=tasks.get(msg.url);
      if(task?.controller.signal.aborted){tasks.delete(msg.url);task=undefined}
      if(!task){
        const controller=new AbortController(),created:ScanTask={controller,consumers:new Map(),promise:Promise.resolve(null as unknown as ScanResult)};
        task=created;tasks.set(msg.url,created);addConsumer(created,msg,sender);
        created.promise=executeScan(msg.url,msg.kind,settings,created,cached?.discourseSeed).finally(()=>{if(tasks.get(msg.url)===created)tasks.delete(msg.url)});
      }else addConsumer(task,msg,sender);
      return task.promise;
    })().then(sendResponse).catch((e:Error)=>sendResponse(e.name==="AbortError"?{cancelled:true}:{error:e.message}));
    return true;
  }
  if(msg?.type==="LINKPEEK_CANCEL_SCAN"){
    const task=tasks.get(msg.url);if(task){
      task.consumers.delete(String(msg.token));
      if(task.consumers.size===0)task.controller.abort();
    }
    sendResponse({ok:true});return;
  }
  if(msg?.type==="LINKPEEK_FETCH_BINARY"){
    (async()=>{
      const url=new URL(msg.url);if(!/^https?:$/.test(url.protocol))throw new Error("Unsupported media URL");
      const maxBytes=Math.max(1,Math.min(100,Number(msg.maxMb)||32))*1024*1024;
      const response=await fetch(url.href,{credentials:"include",redirect:"follow"});if(!response.ok)throw new Error(`HTTP ${response.status} for media`);
      const announced=Number(response.headers.get("content-length")||0);if(announced>maxBytes)throw new Error("GIF is larger than the configured frame-control limit");
      const buffer=await response.arrayBuffer();if(buffer.byteLength>maxBytes)throw new Error("GIF is larger than the configured frame-control limit");
      return {base64:bytesToBase64(buffer),mime:response.headers.get("content-type")||"application/octet-stream",bytes:buffer.byteLength};
    })().then(sendResponse).catch((e:Error)=>sendResponse({error:e.message}));
    return true;
  }
  if(msg?.type==="LINKPEEK_CLEAR_CACHE"){cache.clear();cacheBytes=0;sendResponse({ok:true});return;}
  if(msg?.type==="LINKPEEK_OPEN_OPTIONS"){chrome.runtime.openOptionsPage();sendResponse({ok:true});return;}
  if(msg?.type==="LINKPEEK_DOWNLOAD"){
    chrome.downloads.download({url:msg.url,filename:msg.filename,saveAs:false}).then(id=>sendResponse({id})).catch((e:Error)=>sendResponse({error:e.message}));
    return true;
  }
});
