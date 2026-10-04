import type {MediaItem,ScanResult} from "../shared/media";
import {dedupeMedia,extractMediaFromHtml} from "./extract";
import type {LinkPeekSettings} from "../shared/settings";
type DPost={id:number;post_number:number;username?:string;cooked?:string};
type DTopic={id:number;title?:string;post_stream?:{posts?:DPost[];stream?:number[]}};
function topicJsonUrl(raw:string){const u=new URL(raw),parts=u.pathname.split("/").filter(Boolean),t=parts.indexOf("t");if(t<0)return null;const idIndex=parts.findIndex((p,i)=>i>t&&/^\d+$/.test(p));if(idIndex<0)return null;u.pathname="/"+parts.slice(0,idIndex+1).join("/")+".json";u.search="";u.hash="";return u}
async function fetchJson(url:string){const r=await fetch(url,{credentials:"include",redirect:"follow"});if(!r.ok)throw new Error(`HTTP ${r.status} for ${url}`);return r.json()}
function fromPosts(posts:DPost[],topicUrl:string,settings?:LinkPeekSettings){const items:MediaItem[]=[];for(const p of posts){if(!p.cooked)continue;items.push(...extractMediaFromHtml(p.cooked,topicUrl,{postId:p.id,postNumber:p.post_number,author:p.username,sourceUrl:`${topicUrl.replace(/\/$/,"")}/${p.post_number}`},settings))}return items}
export async function scanDiscourse(raw:string,batchSize=20,maxPosts=2000,settings?:LinkPeekSettings):Promise<ScanResult>{
  const jsonUrl=topicJsonUrl(raw);if(!jsonUrl)throw new Error("Not a Discourse topic URL");
  const topic=await fetchJson(jsonUrl.href) as DTopic;const topicUrl=new URL(raw);topicUrl.hash="";topicUrl.search="";
  const initial=topic.post_stream?.posts??[];const allStream=topic.post_stream?.stream??[];const effectiveMax=settings?.scanScope==="first"?Math.min(maxPosts,50):maxPosts;const stream=(settings?.scanScope==="page"?initial.map(p=>p.id):allStream).slice(0,effectiveMax);let posts=[...initial];const have=new Set(posts.map(p=>p.id));const missing=stream.filter(id=>!have.has(id));
  for(let i=0;i<missing.length;i+=batchSize){
    const ids=missing.slice(i,i+batchSize),u=new URL(`/t/${topic.id}/posts.json`,jsonUrl.origin);ids.forEach(id=>u.searchParams.append("post_ids[]",String(id)));
    try{const data=await fetchJson(u.href) as {post_stream?:{posts?:DPost[]}};posts.push(...(data.post_stream?.posts??[]))}
    catch{for(const id of ids){try{posts.push(await fetchJson(new URL(`/posts/${id}.json`,jsonUrl.origin).href) as DPost)}catch{}}}
  }
  posts=posts.sort((a,b)=>a.post_number-b.post_number);const extracted=fromPosts(posts,topicUrl.href,settings);const d=settings?.dedupe===false?{items:extracted,duplicates:0}:dedupeMedia(extracted);
  return {url:raw,kind:"discourse",title:topic.title,items:d.items,complete:posts.length>=Math.min(stream.length,maxPosts),postsScanned:posts.length,totalPosts:stream.length,diagnostics:{adapter:"Discourse",ignored:0,duplicates:d.duplicates,warnings:[]}};
}
