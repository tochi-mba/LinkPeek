import type {MediaItem,ScanResult} from "../shared/media";
import {dedupeMedia,extractMediaFromHtml} from "./extract";
import type {LinkPeekSettings} from "../shared/settings";

type PageScan={finalUrl:string;title?:string;items:MediaItem[];html?:string;direct:boolean};

const HTTP=/^https?:$/;
const DANGEROUS=/(?:^|\/)(?:logout|log-out|signout|sign-out|delete|remove|unsubscribe|checkout)(?:\/|$)/i;
const NON_PAGE=/\.(?:7z|avi|css|csv|docx?|exe|gz|ico|js|json|m4[av]|mov|mp[34]|pdf|pptx?|rar|tar|txt|wav|webm|xlsx?|xml|zip)(?:$|[?#])/i;
const TRACKING=/^(?:utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i;

function limit(value:number|undefined,fallback:number,min:number,max:number){return Math.max(min,Math.min(max,Number.isFinite(value)?Number(value):fallback))}
function referrerPolicy(settings?:LinkPeekSettings):ReferrerPolicy|undefined{return settings?.referrerPolicy==="never"?"no-referrer":settings?.referrerPolicy==="same-origin"?"same-origin":undefined}
async function fetchPage(url:string,settings:LinkPeekSettings|undefined,signal:AbortSignal|undefined,rootOrigin?:string):Promise<PageScan>{
  const controller=new AbortController(),abort=()=>controller.abort();
  if(signal?.aborted)abort();else signal?.addEventListener("abort",abort,{once:true});
  const timer=setTimeout(abort,limit(settings?.fetchTimeout,8000,500,30000));
  try{
    const credentials=!rootOrigin||new URL(url).origin===rootOrigin?"include":"omit";
    const r=await fetch(url,{credentials,redirect:settings?.followRedirects===false?"manual":"follow",referrerPolicy:referrerPolicy(settings),signal:controller.signal});
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const type=r.headers.get("content-type")||"";
    if(type.startsWith("image/")){
      const item:MediaItem={id:r.url,type:type.includes("gif")?"gif":"image",originalUrl:r.url,previewUrl:r.url,sourceUrl:url,filename:new URL(r.url).pathname.split("/").pop(),score:1};
      return {finalUrl:r.url,items:[item],direct:true};
    }
    const html=await r.text(),title=/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g," ").trim();
    return {finalUrl:r.url,title,items:extractMediaFromHtml(html,r.url,{},settings),html,direct:false};
  }finally{clearTimeout(timer);signal?.removeEventListener("abort",abort)}
}
function linkedPages(html:string,base:string,rootOrigin:string,settings:LinkPeekSettings,seen:Set<string>){
  const out:string[]=[];let match:RegExpExecArray|null;const anchors=/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  while((match=anchors.exec(html))){
    const tag=match[0],raw=match[1].replace(/&amp;/gi,"&");
    if(/\bdownload(?:\s|=|>)/i.test(tag)||/\brel=["'][^"']*\bnofollow\b/i.test(tag))continue;
    try{
      const url=new URL(raw,base);if(!HTTP.test(url.protocol)||url.username||url.password||DANGEROUS.test(url.pathname)||NON_PAGE.test(url.href))continue;
      if(settings.recursiveSearch!=="all"&&url.origin!==rootOrigin)continue;
      url.hash="";if(settings.stripTracking)for(const key of [...url.searchParams.keys()])if(TRACKING.test(key))url.searchParams.delete(key);
      if(settings.canonicalizeQuery)url.searchParams.sort();
      if(seen.has(url.href))continue;seen.add(url.href);out.push(url.href);
    }catch{}
  }
  return out;
}
function finish(raw:string,title:string|undefined,items:MediaItem[],pages:number,failures:number,settings:LinkPeekSettings|undefined,direct=false):ScanResult{
  const deduped=dedupeMedia(items),cap=limit(settings?.maxMediaItems,400,1,5000),capped=deduped.items.length>cap,warnings:string[]=[];
  if(capped)warnings.push(`Stopped at the configured ${cap} media limit.`);
  if(failures)warnings.push(`Skipped ${failures} linked page${failures===1?"":"s"} that could not be read.`);
  return {url:raw,kind:direct?"direct-image":"generic",title,items:deduped.items.slice(0,cap),complete:true,diagnostics:{adapter:pages>1?"Generic linked-page search":direct?"Direct media":"Generic HTML",ignored:failures,duplicates:deduped.duplicates,warnings}};
}

export async function scanGeneric(raw:string,settings?:LinkPeekSettings,signal?:AbortSignal,allowRecursive=true):Promise<ScanResult>{
  const root=await fetchPage(raw,settings,signal),initial=finish(raw,root.title,root.items,1,0,settings,root.direct);
  if(root.direct||!allowRecursive||!settings||settings.recursiveSearch==="off"||(initial.items.length>0&&settings.recursiveTrigger!=="always"))return initial;
  const maxDepth=limit(settings.recursiveMaxDepth,1,1,3),maxPages=limit(settings.recursiveMaxPages,6,1,50),cap=limit(settings.maxMediaItems,400,1,5000);
  if(maxPages===1||!root.html)return initial;
  const rootOrigin=new URL(root.finalUrl).origin,seen=new Set<string>([new URL(root.finalUrl).href]),queue=linkedPages(root.html,root.finalUrl,rootOrigin,settings,seen).map(url=>({url,depth:1}));
  const items:MediaItem[]=[],all=[...root.items];let pages=1,failures=0;
  while(queue.length&&pages<maxPages&&all.length<cap){
    const current=queue.shift()!;let page:PageScan;pages++;
    try{page=await fetchPage(current.url,settings,signal,rootOrigin)}catch(error){if(signal?.aborted)throw error;failures++;continue}
    if(settings.recursiveSearch!=="all"&&new URL(page.finalUrl).origin!==rootOrigin){failures++;continue}
    items.push(...page.items);all.splice(0,all.length,...dedupeMedia([...all,...page.items]).items);
    if(!page.direct&&page.html&&current.depth<maxDepth)queue.push(...linkedPages(page.html,page.finalUrl,rootOrigin,settings,seen).map(url=>({url,depth:current.depth+1})));
  }
  return finish(raw,root.title,[...root.items,...items],pages,failures,settings);
}
