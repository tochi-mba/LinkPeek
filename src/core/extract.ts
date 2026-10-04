import type {MediaItem} from "../shared/media";
import {canonicalMediaUrl} from "../shared/media";
import type {LinkPeekSettings} from "../shared/settings";

const attr=(tag:string,name:string)=>new RegExp(`\\b${name}=["']([^"']+)["']`,"i").exec(tag)?.[1];
const abs=(raw:string,base:string)=>{try{return new URL(raw,base).href}catch{return raw}};
const filename=(url:string)=>{try{return decodeURIComponent(new URL(url).pathname.split("/").pop()||"media")}catch{return "media"}};
type ExtractOptions=Pick<LinkPeekSettings,"includeImages"|"includeGif"|"includeWebp"|"includeAvif"|"includeSvg"|"includeAvatars"|"includeEmoji"|"minWidth"|"minHeight">;
const defaults:ExtractOptions={includeImages:true,includeGif:true,includeWebp:true,includeAvif:true,includeSvg:false,includeAvatars:false,includeEmoji:false,minWidth:120,minHeight:120};
function allowed(url:string,o:ExtractOptions){
  const ext=(new URL(url,"https://example.test").pathname.split(".").pop()||"").toLowerCase();
  if(ext==="gif")return o.includeGif;if(ext==="webp")return o.includeWebp;if(ext==="avif")return o.includeAvif;if(ext==="svg")return o.includeSvg;
  return o.includeImages;
}
export function extractMediaFromHtml(html:string,baseUrl:string,meta:Partial<MediaItem>={},options:Partial<ExtractOptions>={}):MediaItem[]{
  const o={...defaults,...options},out:MediaItem[]=[];const seen=new Set<string>();
  const lightbox=/<a\b[^>]*class=["'][^"']*\blightbox\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;let m:RegExpExecArray|null;
  while((m=lightbox.exec(html))){
    const block=m[0],open=block.match(/^<a\b[^>]*>/i)?.[0]??"",href=attr(open,"href");if(!href)continue;
    const img=block.match(/<img\b[^>]*>/i)?.[0]??"",preview=attr(img,"src")||href,original=abs(href,baseUrl);if(!allowed(original,o))continue;
    const key=canonicalMediaUrl(original);if(seen.has(key))continue;
    const w=Number(attr(img,"width")||0)||undefined,h=Number(attr(img,"height")||0)||undefined;if((w&&w<o.minWidth)||(h&&h<o.minHeight))continue;seen.add(key);
    out.push({id:key,type:/\.gif(?:$|\?)/i.test(original)?"gif":"image",originalUrl:original,previewUrl:abs(preview,baseUrl),sourceUrl:baseUrl,filename:attr(open,"title")||filename(original),width:w,height:h,score:1,...meta});
  }
  const imgs=/<img\b[^>]*>/gi;
  while((m=imgs.exec(html))){
    const tag=m[0],cls=(attr(tag,"class")||"").toLowerCase(),alt=(attr(tag,"alt")||"").toLowerCase(),signals=cls+" "+alt;
    if(!o.includeAvatars&&/avatar/.test(signals))continue;if(!o.includeEmoji&&/emoji|reaction/.test(signals))continue;if(/icon|badge|logo/.test(signals))continue;
    const src=attr(tag,"src");if(!src)continue;const original=abs(src,baseUrl);if(!allowed(original,o))continue;
    const w=Number(attr(tag,"width")||0)||undefined,h=Number(attr(tag,"height")||0)||undefined;if((w&&w<o.minWidth)||(h&&h<o.minHeight))continue;
    const key=canonicalMediaUrl(original);if(seen.has(key))continue;seen.add(key);const srcset=attr(tag,"srcset");let preview=original;
    if(srcset){const choices=srcset.split(",").map(x=>x.trim().split(/\s+/)[0]).filter(Boolean);if(choices.length)preview=abs(choices[choices.length-1],baseUrl)}
    out.push({id:key,type:/\.gif(?:$|\?)/i.test(original)?"gif":"image",originalUrl:original,previewUrl:preview,sourceUrl:baseUrl,filename:attr(tag,"alt")||filename(original),width:w,height:h,score:.65,...meta});
  }
  return out;
}
export function dedupeMedia(items:MediaItem[]):{items:MediaItem[];duplicates:number}{const map=new Map<string,MediaItem>();let duplicates=0;for(const item of items){const key=canonicalMediaUrl(item.originalUrl),prev=map.get(key);if(prev){duplicates++;if(item.score>prev.score)map.set(key,item)}else map.set(key,item)}return {items:[...map.values()],duplicates}}
