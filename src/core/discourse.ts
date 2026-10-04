import type {MediaItem,ScanResult} from "../shared/media";
import {dedupeMedia,extractMediaFromHtml} from "./extract";
import type {LinkPeekSettings} from "../shared/settings";

type DPost={id:number;post_number:number;username?:string;cooked?:string;post_url?:string};
type DTopic={id:number;title?:string;post_stream?:{posts?:DPost[];stream?:number[]}};
export type DiscourseScanHooks={signal?:AbortSignal;initialOnly?:boolean;onProgress?:(result:ScanResult)=>void};

function topicJsonUrl(raw:string){
  const u=new URL(raw),parts=u.pathname.split("/").filter(Boolean),t=parts.indexOf("t");
  if(t<0)return null;
  const idIndex=parts.findIndex((p,i)=>i>t&&/^\d+$/.test(p));if(idIndex<0)return null;
  u.pathname="/"+parts.slice(0,idIndex+1).join("/")+".json";u.search="";u.hash="";return u;
}
async function fetchText(url:string,signal?:AbortSignal){
  const r=await fetch(url,{credentials:"include",redirect:"follow",signal});
  if(!r.ok)throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}
async function fetchJson(url:string,signal?:AbortSignal){return JSON.parse(await fetchText(url,signal))}
export function parsePreloadedDiscourseTopic(html:string,topicId:number):DTopic|null{
  const script=/<script\b[^>]*id=["']data-preloaded["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if(!script)return null;
  try{
    const preload=JSON.parse(script.trim()) as Record<string,unknown>,raw=preload[`topic_${topicId}`];
    if(typeof raw==="string")return JSON.parse(raw) as DTopic;if(raw&&typeof raw==="object")return raw as DTopic;
  }catch{}
  return null;
}
async function fetchTopic(raw:string,jsonUrl:URL,signal?:AbortSignal):Promise<{topic:DTopic;warning?:string}>{
  try{return {topic:await fetchJson(jsonUrl.href,signal) as DTopic}}
  catch(primaryError){
    if(signal?.aborted)throw primaryError;
    const id=Number(/(\d+)\.json$/.exec(jsonUrl.pathname)?.[1]);if(!id)throw primaryError;
    const html=await fetchText(raw,signal),fallback=parsePreloadedDiscourseTopic(html,id);if(!fallback)throw primaryError;
    return {topic:fallback,warning:"Used embedded Discourse topic data after the JSON endpoint was unavailable."};
  }
}
function fromPosts(posts:DPost[],topicUrl:string,settings?:LinkPeekSettings){
  const items:MediaItem[]=[];
  for(const p of posts){
    if(!p.cooked)continue;
    const source=p.post_url?new URL(p.post_url,topicUrl).href:`${topicUrl.replace(/\/$/,"")}/${p.post_number}`;
    items.push(...extractMediaFromHtml(p.cooked,topicUrl,{postId:p.id,postNumber:p.post_number,author:p.username,sourceUrl:source},settings));
  }
  return items;
}
function resultFromPosts(raw:string,title:string|undefined,posts:DPost[],streamLength:number,effectiveMax:number,topicUrl:string,settings:LinkPeekSettings|undefined,warnings:string[],complete:boolean):ScanResult{
  const unique=new Map(posts.map(p=>[p.id,p])),ordered=[...unique.values()].sort((a,b)=>a.post_number-b.post_number);
  const extracted=fromPosts(ordered,topicUrl,settings),d=settings?.dedupe===false?{items:extracted,duplicates:0}:dedupeMedia(extracted);
  return {url:raw,kind:"discourse",title,items:d.items,complete,postsScanned:ordered.length,totalPosts:streamLength,diagnostics:{adapter:"Discourse",ignored:0,duplicates:d.duplicates,warnings}};
}
export async function scanDiscourse(raw:string,batchSize=40,maxPosts=2000,settings?:LinkPeekSettings,hooks:DiscourseScanHooks={}):Promise<ScanResult>{
  const {signal,onProgress,initialOnly=false}=hooks,jsonUrl=topicJsonUrl(raw);if(!jsonUrl)throw new Error("Not a Discourse topic URL");
  signal?.throwIfAborted();
  const fetched=await fetchTopic(raw,jsonUrl,signal),topic=fetched.topic,topicUrl=new URL(raw);topicUrl.hash="";topicUrl.search="";
  const initial=topic.post_stream?.posts??[],allStream=topic.post_stream?.stream??[],effectiveMax=settings?.scanScope==="first"?Math.min(maxPosts,50):maxPosts;
  const stream=(settings?.scanScope==="page"?initial.map(p=>p.id):allStream).slice(0,effectiveMax),warnings=fetched.warning?[fetched.warning]:[];
  const posts=[...initial],have=new Set(posts.map(p=>p.id)),missing=stream.filter(id=>!have.has(id));
  const initialResult=resultFromPosts(raw,topic.title,posts,stream.length,effectiveMax,topicUrl.href,settings,warnings,missing.length===0);
  onProgress?.(initialResult);
  if(initialOnly||missing.length===0)return initialResult;

  const safeBatch=Math.max(10,Math.min(50,batchSize||40)),batches:Array<number[]>=[];
  for(let i=0;i<missing.length;i+=safeBatch)batches.push(missing.slice(i,i+safeBatch));
  const concurrency=Math.max(1,Math.min(4,settings?.maxRequests??3));let cursor=0,completed=0;

  const fetchBatch=async(ids:number[])=>{
    signal?.throwIfAborted();
    const u=new URL(`/t/${topic.id}/posts.json`,jsonUrl.origin);ids.forEach(id=>u.searchParams.append("post_ids[]",String(id)));
    try{
      const data=await fetchJson(u.href,signal) as {post_stream?:{posts?:DPost[]}};return data.post_stream?.posts??[];
    }catch(error){
      if(signal?.aborted)throw error;
      const recovered:DPost[]=[];
      for(const id of ids){
        signal?.throwIfAborted();
        try{recovered.push(await fetchJson(new URL(`/posts/${id}.json`,jsonUrl.origin).href,signal) as DPost)}catch(inner){if(signal?.aborted)throw inner}
      }
      return recovered;
    }
  };
  const worker=async()=>{
    while(true){
      const index=cursor++;if(index>=batches.length)return;
      const fetchedPosts=await fetchBatch(batches[index]);posts.push(...fetchedPosts);completed++;
      if(onProgress&&(completed%concurrency===0||completed===batches.length)){
        onProgress(resultFromPosts(raw,topic.title,posts,stream.length,effectiveMax,topicUrl.href,settings,warnings,false));
      }
    }
  };
  await Promise.all(Array.from({length:Math.min(concurrency,batches.length)},()=>worker()));
  signal?.throwIfAborted();
  return resultFromPosts(raw,topic.title,posts,stream.length,effectiveMax,topicUrl.href,settings,warnings,true);
}
