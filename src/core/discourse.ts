import type {MediaItem,ScanResult} from "../shared/media";
import {dedupeMedia,extractMediaFromHtml} from "./extract";
import type {LinkPeekSettings} from "../shared/settings";

export type DPost={id:number;post_number:number;username?:string;cooked?:string;post_url?:string};
export type DTopic={id:number;title?:string;post_stream?:{posts?:DPost[];stream?:number[]}};
export type DiscourseSeed={topic:DTopic;warning?:string};
export type DiscourseScanHooks={signal?:AbortSignal;onProgress?:(result:ScanResult)=>void};

function ensureNotAborted(signal?:AbortSignal){if(signal?.aborted)throw new DOMException("Aborted","AbortError")}
function topicJsonUrl(raw:string){
  const u=new URL(raw),parts=u.pathname.split("/").filter(Boolean),t=parts.indexOf("t");if(t<0)return null;
  const idIndex=parts.findIndex((p,i)=>i>t&&/^\d+$/.test(p));if(idIndex<0)return null;
  u.pathname="/"+parts.slice(0,idIndex+1).join("/")+".json";u.search="";u.hash="";return u;
}
async function fetchText(url:string,signal?:AbortSignal){
  ensureNotAborted(signal);const r=await fetch(url,{credentials:"include",redirect:"follow",signal});
  if(!r.ok)throw new Error(`HTTP ${r.status} for ${url}`);return r.text();
}
async function fetchJson(url:string,signal?:AbortSignal){return JSON.parse(await fetchText(url,signal))}
export function parsePreloadedDiscourseTopic(html:string,topicId:number):DTopic|null{
  const script=/<script\b[^>]*id=["']data-preloaded["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];if(!script)return null;
  try{const preload=JSON.parse(script.trim()) as Record<string,unknown>,raw=preload[`topic_${topicId}`];if(typeof raw==="string")return JSON.parse(raw) as DTopic;if(raw&&typeof raw==="object")return raw as DTopic}catch{}
  return null;
}
async function fetchTopic(raw:string,jsonUrl:URL,signal?:AbortSignal):Promise<DiscourseSeed>{
  try{return {topic:await fetchJson(jsonUrl.href,signal) as DTopic}}
  catch(primaryError){
    if(signal?.aborted)throw primaryError;const id=Number(/(\d+)\.json$/.exec(jsonUrl.pathname)?.[1]);if(!id)throw primaryError;
    const html=await fetchText(raw,signal),fallback=parsePreloadedDiscourseTopic(html,id);if(!fallback)throw primaryError;
    return {topic:fallback,warning:"Used embedded Discourse topic data after the JSON endpoint was unavailable."};
  }
}
function fromPosts(posts:DPost[],topicUrl:string,settings?:LinkPeekSettings){
  const items:MediaItem[]=[];for(const p of posts){if(!p.cooked)continue;
    const source=p.post_url?new URL(p.post_url,topicUrl).href:`${topicUrl.replace(/\/$/,"")}/${p.post_number}`;
    items.push(...extractMediaFromHtml(p.cooked,topicUrl,{postId:p.id,postNumber:p.post_number,author:p.username,sourceUrl:source},settings));
  }return items;
}
function resultFromItems(raw:string,topic:DTopic,items:MediaItem[],postsScanned:number,totalPosts:number,settings?:LinkPeekSettings,complete=false,warning?:string):ScanResult{
  const d=settings?.dedupe===false?{items,duplicates:0}:dedupeMedia(items);
  return {url:raw,kind:"discourse",title:topic.title,items:d.items,complete,postsScanned,totalPosts,diagnostics:{adapter:"Discourse",ignored:0,duplicates:d.duplicates,warnings:warning?[warning]:[]}};
}
function initialState(raw:string,topic:DTopic,posts:DPost[],stream:number[],settings?:LinkPeekSettings,warning?:string){
  const topicUrl=new URL(raw);topicUrl.hash="";topicUrl.search="";
  const unique=[...new Map(posts.map(p=>[p.id,p])).values()].sort((a,b)=>a.post_number-b.post_number),items=fromPosts(unique,topicUrl.href,settings);
  return {topicUrl:topicUrl.href,posts:unique,items,result:resultFromItems(raw,topic,items,unique.length,stream.length,settings,unique.length>=stream.length,warning)};
}
export async function prefetchDiscourse(raw:string,settings?:LinkPeekSettings,signal?:AbortSignal):Promise<{result:ScanResult;seed:DiscourseSeed}>{
  const jsonUrl=topicJsonUrl(raw);if(!jsonUrl)throw new Error("Not a Discourse topic URL");
  const seed=await fetchTopic(raw,jsonUrl,signal),topic=seed.topic,initial=topic.post_stream?.posts??[],allStream=topic.post_stream?.stream??[];
  const effectiveMax=settings?.scanScope==="first"?Math.min(settings.maxPosts,50):settings?.maxPosts??2000,stream=(settings?.scanScope==="page"?initial.map(p=>p.id):allStream).slice(0,effectiveMax);
  return {result:initialState(raw,topic,initial,stream,settings,seed.warning).result,seed};
}
async function fetchBatch(topicId:number,origin:string,ids:number[],signal?:AbortSignal):Promise<DPost[]>{
  ensureNotAborted(signal);const u=new URL(`/t/${topicId}/posts.json`,origin);ids.forEach(id=>u.searchParams.append("post_ids[]",String(id)));
  try{const data=await fetchJson(u.href,signal) as {post_stream?:{posts?:DPost[]}};return data.post_stream?.posts??[]}
  catch(error){
    if(signal?.aborted)throw error;const recovered:DPost[]=[];
    for(const id of ids){ensureNotAborted(signal);try{recovered.push(await fetchJson(new URL(`/posts/${id}.json`,origin).href,signal) as DPost)}catch(inner){if(signal?.aborted)throw inner}}
    return recovered;
  }
}
export async function scanDiscourse(raw:string,batchSize=50,maxPosts=2000,settings?:LinkPeekSettings,seed?:DiscourseSeed,hooks:DiscourseScanHooks={}):Promise<ScanResult>{
  const {signal,onProgress}=hooks,jsonUrl=topicJsonUrl(raw);if(!jsonUrl)throw new Error("Not a Discourse topic URL");ensureNotAborted(signal);
  const fetched=seed??await fetchTopic(raw,jsonUrl,signal),topic=fetched.topic,initial=topic.post_stream?.posts??[],allStream=topic.post_stream?.stream??[];
  const effectiveMax=settings?.scanScope==="first"?Math.min(maxPosts,50):maxPosts,stream=(settings?.scanScope==="page"?initial.map(p=>p.id):allStream).slice(0,effectiveMax);
  const state=initialState(raw,topic,initial,stream,settings,fetched.warning),have=new Set(state.posts.map(p=>p.id)),missing=stream.filter(id=>!have.has(id));
  const initialResult={...state.result,complete:missing.length===0};if(missing.length===0)return initialResult;
  let initialProgressTimer:ReturnType<typeof setTimeout>|undefined,lastProgressAt=performance.now();
  if(onProgress)initialProgressTimer=setTimeout(()=>{initialProgressTimer=undefined;lastProgressAt=performance.now();onProgress(initialResult)},75);

  const size=Math.max(1,Math.min(100,batchSize||50)),idBatches:number[][]=[];
  for(let i=0;i<missing.length;i+=size)idBatches.push(missing.slice(i,i+size));
  const batchPosts:Array<DPost[]|undefined>=new Array(idBatches.length),batchItems:Array<MediaItem[]|undefined>=new Array(idBatches.length);
  let cursor=0,completed=0;
  const concurrency=Math.max(1,Math.min(settings?.maxRequests??3,idBatches.length||1));
  const compose=(complete=false)=>{
    const postsScanned=state.posts.length+batchPosts.reduce((n,b)=>n+(b?.length??0),0);
    const items=[...state.items,...batchItems.flatMap(x=>x??[])];
    return resultFromItems(raw,topic,items,postsScanned,stream.length,settings,complete,fetched.warning);
  };
  const workers=Array.from({length:concurrency},async()=>{
    while(true){
      ensureNotAborted(signal);const index=cursor++;if(index>=idBatches.length)return;
      const posts=await fetchBatch(topic.id,jsonUrl.origin,idBatches[index],signal);batchPosts[index]=posts;batchItems[index]=fromPosts(posts,state.topicUrl,settings);completed++;
      const now=performance.now();
      if(onProgress&&completed<idBatches.length&&now-lastProgressAt>=120){lastProgressAt=now;onProgress(compose(false))}
    }
  });
  try{
    await Promise.all(workers);ensureNotAborted(signal);
    const final=compose(true);final.complete=(final.postsScanned??0)>=Math.min(stream.length,effectiveMax);return final;
  }finally{
    if(initialProgressTimer)clearTimeout(initialProgressTimer);
  }
}
