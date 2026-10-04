import {scanDiscourse} from "./core/discourse";
import {scanGeneric} from "./core/generic";
import {DEFAULT_SETTINGS,effectiveSettings,loadSettings,type LinkPeekSettings} from "./shared/settings";
import type {ScanResult} from "./shared/media";

type CacheEntry={at:number;bytes:number;result:ScanResult};
type Consumer={token:string;tabId?:number;frameId?:number};
type ScanTask={controller:AbortController;consumers:Map<string,Consumer>;promise:Promise<ScanResult>};

const cache=new Map<string,CacheEntry>();let cacheBytes=0;
const warmCache=new Map<string,{at:number;result:ScanResult}>();
const warmTasks=new Map<string,Promise<void>>();
const tasks=new Map<string,ScanTask>();

function bytesToBase64(buffer:ArrayBuffer){
  const bytes=new Uint8Array(buffer);let binary="";const size=0x8000;
  for(let i=0;i<bytes.length;i+=size)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+size,bytes.length)));
  return btoa(binary);
}
function estimateResultBytes(result:ScanResult){
  try{return new TextEncoder().encode(JSON.stringify(result)).byteLength}catch{return result.items.length*256+1024}
}
function deleteCache(url:string){
  const existing=cache.get(url);if(!existing)return;cacheBytes=Math.max(0,cacheBytes-existing.bytes);cache.delete(url);
}
function getCached(url:string,settings:LinkPeekSettings){
  const entry=cache.get(url);if(!entry)return undefined;
  if(Date.now()-entry.at>=settings.cacheMinutes*60_000){deleteCache(url);return undefined}
  cache.delete(url);cache.set(url,entry);return entry.result;
}
function putCached(url:string,result:ScanResult,settings:LinkPeekSettings){
  deleteCache(url);const bytes=estimateResultBytes(result),limit=Math.max(1,settings.maxCacheMb)*1024*1024;
  if(bytes>limit)return;
  cache.set(url,{at:Date.now(),bytes,result});cacheBytes+=bytes;
  while(cacheBytes>limit&&cache.size){
    const oldest=cache.keys().next().value as string|undefined;if(!oldest)break;deleteCache(oldest);
  }
}
function getWarm(url:string,settings:LinkPeekSettings){
  const entry=warmCache.get(url);if(!entry)return undefined;
  if(Date.now()-entry.at>=Math.min(settings.cacheMinutes,10)*60_000){warmCache.delete(url);return undefined}
  warmCache.delete(url);warmCache.set(url,entry);return entry.result;
}
function putWarm(url:string,result:ScanResult){
  warmCache.delete(url);warmCache.set(url,{at:Date.now(),result});
  while(warmCache.size>24){const oldest=warmCache.keys().next().value as string|undefined;if(!oldest)break;warmCache.delete(oldest)}
}
function broadcast(task:ScanTask,url:string,result:ScanResult){
  for(const consumer of task.consumers.values()){
    if(consumer.tabId==null)continue;
    chrome.tabs.sendMessage(consumer.tabId,{type:"LINKPEEK_SCAN_PROGRESS",token:consumer.token,url,result},{frameId:consumer.frameId??0}).catch(()=>{});
  }
}
async function runScan(url:string,kind:string,settings:LinkPeekSettings,task:ScanTask){
  const warm=getWarm(url,settings);if(warm&&settings.progressiveScan)broadcast(task,url,warm);
  let result:ScanResult;
  if(kind==="discourse"){
    result=await scanDiscourse(url,settings.batchSize,settings.maxPosts,settings,{
      signal:task.controller.signal,
      onProgress:settings.progressiveScan?(progress)=>broadcast(task,url,progress):undefined
    });
  }else if(kind==="direct-image"){
    result={url,kind:"direct-image",items:[{id:url,type:/\.gif/i.test(url)?"gif":"image",originalUrl:url,previewUrl:url,sourceUrl:url,score:1}],complete:true,diagnostics:{adapter:"Direct media",ignored:0,duplicates:0,warnings:[]}};
  }else result=await scanGeneric(url,settings,task.controller.signal);
  if(settings.cacheThreads)putCached(url,result,settings);warmCache.delete(url);return result;
}
async function prepare(url:string,kind:string,settings:LinkPeekSettings){
  if(kind!=="discourse"||getCached(url,settings)||getWarm(url,settings)||warmTasks.has(url))return;
  const controller=new AbortController();
  const promise=scanDiscourse(url,settings.batchSize,settings.maxPosts,settings,{signal:controller.signal,initialOnly:true})
    .then(result=>putWarm(url,result)).catch(()=>{}).finally(()=>warmTasks.delete(url));
  warmTasks.set(url,promise);await promise;
}
function addConsumer(task:ScanTask,msg:any,sender:chrome.runtime.MessageSender){
  const token=String(msg.token||`${Date.now()}-${Math.random()}`);
  task.consumers.set(token,{token,tabId:sender.tab?.id,frameId:sender.frameId});return token;
}

chrome.runtime.onInstalled.addListener(async details=>{
  if(details.reason==="install"){
    await chrome.storage.local.set({settings:DEFAULT_SETTINGS});
    chrome.tabs.create({url:chrome.runtime.getURL("onboarding.html")});
  }
});

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg?.type==="LINKPEEK_SCAN"){
    (async()=>{
      const globalSettings=await loadSettings(),settings=effectiveSettings(globalSettings,msg.url),cached=getCached(msg.url,settings);
      if(cached)return cached;
      let task=tasks.get(msg.url);
      if(task?.controller.signal.aborted){tasks.delete(msg.url);task=undefined}
      if(!task){
        const controller=new AbortController();
        task={controller,consumers:new Map(),promise:Promise.resolve(null as unknown as ScanResult)};
        tasks.set(msg.url,task);addConsumer(task,msg,sender);
        const created=task;
        task.promise=runScan(msg.url,msg.kind,settings,task).finally(()=>{if(tasks.get(msg.url)===created)tasks.delete(msg.url)});
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
  if(msg?.type==="LINKPEEK_PREFETCH"){
    (async()=>{
      const globalSettings=await loadSettings(),settings=effectiveSettings(globalSettings,msg.url);
      await prepare(msg.url,msg.kind,settings);return {ok:true};
    })().then(sendResponse).catch(()=>sendResponse({ok:false}));
    return true;
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
  if(msg?.type==="LINKPEEK_CLEAR_CACHE"){cache.clear();cacheBytes=0;warmCache.clear();sendResponse({ok:true});return;}
  if(msg?.type==="LINKPEEK_OPEN_OPTIONS"){chrome.runtime.openOptionsPage();sendResponse({ok:true});return;}
  if(msg?.type==="LINKPEEK_DOWNLOAD"){
    chrome.downloads.download({url:msg.url,filename:msg.filename,saveAs:false}).then(id=>sendResponse({id})).catch((e:Error)=>sendResponse({error:e.message}));
    return true;
  }
});
