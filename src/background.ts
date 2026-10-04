import {scanDiscourse} from "./core/discourse";
import {scanGeneric} from "./core/generic";
import {DEFAULT_SETTINGS,loadSettings} from "./shared/settings";
import type {ScanResult} from "./shared/media";

const cache=new Map<string,{at:number,result:ScanResult}>();

chrome.runtime.onInstalled.addListener(async details=>{
  if(details.reason==="install"){
    await chrome.storage.local.set({settings:DEFAULT_SETTINGS});
    chrome.tabs.create({url:chrome.runtime.getURL("onboarding.html")});
  }
});

chrome.runtime.onMessage.addListener((msg,_sender,sendResponse)=>{
  if(msg?.type==="LINKPEEK_SCAN"){
    (async()=>{
      const settings=await loadSettings();
      const cached=cache.get(msg.url);
      if(cached&&Date.now()-cached.at<settings.cacheMinutes*60_000)return cached.result;
      let result:ScanResult;
      if(msg.kind==="discourse")result=await scanDiscourse(msg.url,settings.batchSize,settings.maxPosts,settings);
      else if(msg.kind==="direct-image")result={url:msg.url,kind:"direct-image",items:[{id:msg.url,type:/\.gif/i.test(msg.url)?"gif":"image",originalUrl:msg.url,previewUrl:msg.url,sourceUrl:msg.url,score:1}],complete:true,diagnostics:{adapter:"Direct media",ignored:0,duplicates:0,warnings:[]}};
      else result=await scanGeneric(msg.url,settings);
      if(settings.cacheThreads)cache.set(msg.url,{at:Date.now(),result});
      return result;
    })().then(sendResponse).catch((e:Error)=>sendResponse({error:e.message}));
    return true;
  }
  if(msg?.type==="LINKPEEK_CLEAR_CACHE"){cache.clear();sendResponse({ok:true});return;}
  if(msg?.type==="LINKPEEK_OPEN_OPTIONS"){chrome.runtime.openOptionsPage();sendResponse({ok:true});return;}
  if(msg?.type==="LINKPEEK_DOWNLOAD"){
    chrome.downloads.download({url:msg.url,filename:msg.filename,saveAs:false}).then(id=>sendResponse({id})).catch((e:Error)=>sendResponse({error:e.message}));
    return true;
  }
});
