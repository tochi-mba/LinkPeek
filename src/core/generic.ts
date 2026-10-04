import type {ScanResult} from "../shared/media";
import {dedupeMedia,extractMediaFromHtml} from "./extract";
import type {LinkPeekSettings} from "../shared/settings";
export async function scanGeneric(raw:string,settings?:LinkPeekSettings):Promise<ScanResult>{
  const r=await fetch(raw,{credentials:"include",redirect:"follow"});if(!r.ok)throw new Error(`HTTP ${r.status}`);
  const type=r.headers.get("content-type")||"";
  if(type.startsWith("image/"))return {url:raw,kind:"direct-image",items:[{id:r.url,type:type.includes("gif")?"gif":"image",originalUrl:r.url,previewUrl:r.url,sourceUrl:raw,filename:new URL(r.url).pathname.split("/").pop(),score:1}],complete:true,diagnostics:{adapter:"Direct media",ignored:0,duplicates:0,warnings:[]}};
  const html=await r.text(),title=/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g," ").trim(),extracted=extractMediaFromHtml(html,r.url,{},settings),d=settings?.dedupe===false?{items:extracted,duplicates:0}:dedupeMedia(extracted);
  return {url:raw,kind:"generic",title,items:d.items,complete:true,diagnostics:{adapter:"Generic HTML",ignored:0,duplicates:d.duplicates,warnings:[]}};
}
