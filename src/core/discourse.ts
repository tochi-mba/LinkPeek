import type {MediaItem,ScanResult} from "../shared/media";
import {dedupeMedia,extractMediaFromHtml} from "./extract";
import type {LinkPeekSettings} from "../shared/settings";

export type DPost={id:number;post_number:number;username?:string;cooked?:string;post_url?:string};
export type DTopic={id:number;title?:string;post_stream?:{posts?:DPost[];stream?:number[]}};
export type DiscourseSeed={topic:DTopic;warning?:string};

function topicJsonUrl(raw:string){
  const u=new URL(raw),parts=u.pathname.split("/").filter(Boolean),t=parts.indexOf("t");
  if(t<0)return null;
  const idIndex=parts.findIndex((p,i)=>i>t&&/^\d+$/.test(p));if(idIndex<0)return null;
  u.pathname="/"+parts.slice(0,idIndex+1).join("/")+".json";u.search="";u.hash="";return u;
}
async function fetchText(url:string){
  const r=await fetch(url,{credentials:"include",redirect:"follow"});
  if(!r.ok)throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}
async function fetchJson(url:string){return JSON.parse(await fetchText(url))}
export function parsePreloadedDiscourseTopic(html:string,topicId:number):DTopic|null{
  const script=/<script\b[^>]*id=["']data-preloaded["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if(!script)return null;
  try{
    const preload=JSON.parse(script.trim()) as Record<string,unknown>;
    const raw=preload[`topic_${topicId}`];
    if(typeof raw==="string")return JSON.parse(raw) as DTopic;
    if(raw&&typeof raw==="object")return raw as DTopic;
  }catch{}
  return null;
}
async function fetchTopic(raw:string,jsonUrl:URL):Promise<DiscourseSeed>{
  try{return {topic:await fetchJson(jsonUrl.href) as DTopic}}
  catch(primaryError){
    const id=Number(/(\d+)\.json$/.exec(jsonUrl.pathname)?.[1]);
    if(!id)throw primaryError;
    const html=await fetchText(raw);
    const fallback=parsePreloadedDiscourseTopic(html,id);
    if(!fallback)throw primaryError;
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
function makeResult(raw:string,topic:DTopic,posts:DPost[],stream:number[],settings?:LinkPeekSettings,complete=false,warning?:string):ScanResult{
  const topicUrl=new URL(raw);topicUrl.hash="";topicUrl.search="";
  const unique=new Map(posts.map(p=>[p.id,p]));
  const ordered=[...unique.values()].sort((a,b)=>a.post_number-b.post_number);
  const extracted=fromPosts(ordered,topicUrl.href,settings),d=settings?.dedupe===false?{items:extracted,duplicates:0}:dedupeMedia(extracted);
  return {
    url:raw,kind:"discourse",title:topic.title,items:d.items,complete,
    postsScanned:ordered.length,totalPosts:stream.length,
    diagnostics:{adapter:"Discourse",ignored:0,duplicates:d.duplicates,warnings:warning?[warning]:[]}
  };
}
export async function prefetchDiscourse(raw:string,settings?:LinkPeekSettings):Promise<{result:ScanResult;seed:DiscourseSeed}>{
  const jsonUrl=topicJsonUrl(raw);if(!jsonUrl)throw new Error("Not a Discourse topic URL");
  const seed=await fetchTopic(raw,jsonUrl),topic=seed.topic;
  const initial=topic.post_stream?.posts??[],allStream=topic.post_stream?.stream??[];
  const effectiveMax=settings?.scanScope==="first"?Math.min(settings.maxPosts,50):settings?.maxPosts??2000;
  const stream=(settings?.scanScope==="page"?initial.map(p=>p.id):allStream).slice(0,effectiveMax);
  const result=makeResult(raw,topic,initial,stream,settings,initial.length>=stream.length,seed.warning);
  return {result,seed};
}
async function fetchBatch(topicId:number,origin:string,ids:number[]):Promise<DPost[]>{
  const u=new URL(`/t/${topicId}/posts.json`,origin);
  ids.forEach(id=>u.searchParams.append("post_ids[]",String(id)));
  try{
    const data=await fetchJson(u.href) as {post_stream?:{posts?:DPost[]}};
    return data.post_stream?.posts??[];
  }catch{
    const recovered:DPost[]=[];
    for(const id of ids){
      try{recovered.push(await fetchJson(new URL(`/posts/${id}.json`,origin).href) as DPost)}catch{}
    }
    return recovered;
  }
}
export async function scanDiscourse(raw:string,batchSize=50,maxPosts=2000,settings?:LinkPeekSettings,seed?:DiscourseSeed):Promise<ScanResult>{
  const jsonUrl=topicJsonUrl(raw);if(!jsonUrl)throw new Error("Not a Discourse topic URL");
  const fetched=seed??await fetchTopic(raw,jsonUrl),topic=fetched.topic;
  const initial=topic.post_stream?.posts??[],allStream=topic.post_stream?.stream??[];
  const effectiveMax=settings?.scanScope==="first"?Math.min(maxPosts,50):maxPosts;
  const stream=(settings?.scanScope==="page"?initial.map(p=>p.id):allStream).slice(0,effectiveMax);
  const posts=[...initial],have=new Set(posts.map(p=>p.id)),missing=stream.filter(id=>!have.has(id));
  const size=Math.max(1,Math.min(100,batchSize||50)),batches:DPost[][]=[],idBatches:number[][]=[];
  for(let i=0;i<missing.length;i+=size)idBatches.push(missing.slice(i,i+size));
  let cursor=0;
  const concurrency=Math.max(1,Math.min(settings?.maxRequests??3,idBatches.length||1));
  const workers=Array.from({length:concurrency},async()=>{
    while(true){
      const index=cursor++;if(index>=idBatches.length)return;
      batches[index]=await fetchBatch(topic.id,jsonUrl.origin,idBatches[index]);
    }
  });
  await Promise.all(workers);
  for(const batch of batches)if(batch)posts.push(...batch);
  return makeResult(raw,topic,posts,stream,settings,posts.length>=Math.min(stream.length,effectiveMax),fetched.warning);
}
