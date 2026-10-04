import type {MediaItem} from "../shared/media";
import {canonicalMediaUrl} from "../shared/media";

const attr=(tag:string,name:string)=>new RegExp(`\\b${name}=["']([^"']+)["']`,"i").exec(tag)?.[1];
const abs=(raw:string,base:string)=>{try{return new URL(raw,base).href}catch{return raw}};
const filename=(url:string)=>{try{return decodeURIComponent(new URL(url).pathname.split("/").pop()||"media")}catch{return "media"}};

export function extractMediaFromHtml(html:string,baseUrl:string,meta:Partial<MediaItem>={}):MediaItem[]{
  const out:MediaItem[]=[];
  const seen=new Set<string>();
  const lightbox=/<a\b[^>]*class=["'][^"']*\blightbox\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
  let m:RegExpExecArray|null;
  while((m=lightbox.exec(html))){
    const block=m[0],open=block.match(/^<a\b[^>]*>/i)?.[0]??"";
    const href=attr(open,"href");if(!href)continue;
    const img=block.match(/<img\b[^>]*>/i)?.[0]??"";
    const preview=attr(img,"src")||href;
    const original=abs(href,baseUrl),key=canonicalMediaUrl(original);
    if(seen.has(key))continue;seen.add(key);
    const w=Number(attr(img,"width")||0)||undefined,h=Number(attr(img,"height")||0)||undefined;
    out.push({id:key,type:/\.gif(?:$|\?)/i.test(original)?"gif":"image",originalUrl:original,previewUrl:abs(preview,baseUrl),sourceUrl:baseUrl,filename:attr(open,"title")||filename(original),width:w,height:h,score:1,...meta});
  }
  const imgs=/<img\b[^>]*>/gi;
  while((m=imgs.exec(html))){
    const tag=m[0],cls=(attr(tag,"class")||"").toLowerCase(),alt=(attr(tag,"alt")||"").toLowerCase();
    if(/avatar|emoji|icon|badge|logo|reaction/.test(cls+" "+alt))continue;
    const src=attr(tag,"src");if(!src)continue;
    const w=Number(attr(tag,"width")||0)||undefined,h=Number(attr(tag,"height")||0)||undefined;
    if((w&&w<120)||(h&&h<120))continue;
    const original=abs(src,baseUrl),key=canonicalMediaUrl(original);if(seen.has(key))continue;seen.add(key);
    const srcset=attr(tag,"srcset");let preview=original;
    if(srcset){const choices=srcset.split(",").map(x=>x.trim().split(/\s+/)[0]).filter(Boolean);if(choices.length)preview=abs(choices[choices.length-1],baseUrl)}
    out.push({id:key,type:/\.gif(?:$|\?)/i.test(original)?"gif":"image",originalUrl:original,previewUrl:preview,sourceUrl:baseUrl,filename:attr(tag,"alt")||filename(original),width:w,height:h,score:.65,...meta});
  }
  return out;
}
export function dedupeMedia(items:MediaItem[]):{items:MediaItem[];duplicates:number}{
  const map=new Map<string,MediaItem>();let duplicates=0;
  for(const item of items){const key=canonicalMediaUrl(item.originalUrl);const prev=map.get(key);if(prev){duplicates++;if(item.score>prev.score)map.set(key,item)}else map.set(key,item)}
  return {items:[...map.values()],duplicates};
}
