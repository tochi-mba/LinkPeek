import type {MediaItem} from "../shared/media";
import {canonicalMediaUrl} from "../shared/media";
import type {LinkPeekSettings} from "../shared/settings";

const attr=(tag:string,name:string)=>new RegExp(`\\b${name}=["']([^"']+)["']`,"i").exec(tag)?.[1];
const abs=(raw:string,base:string)=>{try{return new URL(raw,base).href}catch{return raw}};
const filename=(url:string)=>{try{return decodeURIComponent(new URL(url).pathname.split("/").pop()||"media")}catch{return "media"}};
type ExtractOptions=Pick<LinkPeekSettings,"includeImages"|"includeGif"|"includeWebp"|"includeAvif"|"includeSvg"|"includeAvatars"|"includeEmoji"|"minWidth"|"minHeight"|"quotedDuplicates">;
const defaults:ExtractOptions={includeImages:true,includeGif:true,includeWebp:true,includeAvif:true,includeSvg:false,includeAvatars:false,includeEmoji:false,minWidth:120,minHeight:120,quotedDuplicates:"hide"};

function allowed(url:string,o:ExtractOptions){
  const ext=(new URL(url,"https://example.test").pathname.split(".").pop()||"").toLowerCase();
  if(ext==="gif")return o.includeGif;if(ext==="webp")return o.includeWebp;if(ext==="avif")return o.includeAvif;if(ext==="svg")return o.includeSvg;
  return o.includeImages;
}
function withoutQuotedBlocks(html:string){
  return html.replace(/<aside\b[^>]*class=["'][^"']*\bquote\b[^"']*["'][^>]*>[\s\S]*?<\/aside>/gi,"");
}
function mediaId(tag:string,url:string){
  const sha=attr(tag,"data-base62-sha1");return sha?`upload:${sha}`:canonicalMediaUrl(url);
}

export function extractMediaFromHtml(html:string,baseUrl:string,meta:Partial<MediaItem>={},options:Partial<ExtractOptions>={}):MediaItem[]{
  const o={...defaults,...options},source=o.quotedDuplicates==="hide"?withoutQuotedBlocks(html):html,out:MediaItem[]=[];const seen=new Set<string>();
  const lightbox=/<a\b[^>]*class=["'][^"']*\blightbox\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;let m:RegExpExecArray|null;
  while((m=lightbox.exec(source))){
    const block=m[0],open=block.match(/^<a\b[^>]*>/i)?.[0]??"",href=attr(open,"href");if(!href)continue;
    const img=block.match(/<img\b[^>]*>/i)?.[0]??"",preview=attr(img,"src")||href,original=abs(href,baseUrl);if(!allowed(original,o))continue;
    const canonical=canonicalMediaUrl(original),key=mediaId(img,canonical);if(seen.has(key)||seen.has(canonical))continue;
    const w=Number(attr(img,"width")||0)||undefined,h=Number(attr(img,"height")||0)||undefined;if((w&&w<o.minWidth)||(h&&h<o.minHeight))continue;seen.add(key);seen.add(canonical);
    out.push({id:key,type:/\.gif(?:$|\?)/i.test(original)?"gif":"image",originalUrl:original,previewUrl:abs(preview,baseUrl),sourceUrl:baseUrl,filename:attr(open,"title")||attr(img,"alt")||filename(original),width:w,height:h,score:1,...meta});
  }
  const imgs=/<img\b[^>]*>/gi;
  while((m=imgs.exec(source))){
    const tag=m[0],cls=(attr(tag,"class")||"").toLowerCase(),alt=(attr(tag,"alt")||"").toLowerCase(),signals=cls+" "+alt;
    if(!o.includeAvatars&&/avatar/.test(signals))continue;if(!o.includeEmoji&&/emoji|reaction/.test(signals))continue;if(/icon|badge|logo/.test(signals))continue;
    const src=attr(tag,"src");if(!src)continue;const original=abs(src,baseUrl);if(!allowed(original,o))continue;
    const w=Number(attr(tag,"width")||0)||undefined,h=Number(attr(tag,"height")||0)||undefined;if((w&&w<o.minWidth)||(h&&h<o.minHeight))continue;
    const canonical=canonicalMediaUrl(original),key=mediaId(tag,canonical);if(seen.has(key)||seen.has(canonical))continue;seen.add(key);seen.add(canonical);
    const srcset=attr(tag,"srcset");let preview=original;
    if(srcset){const choices=srcset.split(",").map(x=>x.trim().split(/\s+/)[0]).filter(Boolean);const optimized=choices.find(x=>/\/optimized\//.test(x));preview=abs(optimized||choices[0]||original,baseUrl)}
    const animated=/\banimated\b/.test(cls)||/\.gif(?:$|\?)/i.test(original);
    out.push({id:key,type:animated?"gif":"image",originalUrl:canonical,previewUrl:preview,sourceUrl:baseUrl,filename:attr(tag,"alt")||filename(original),width:w,height:h,score:animated?0.9:0.65,...meta});
  }
  return out;
}
export function dedupeMedia(items:MediaItem[]):{items:MediaItem[];duplicates:number}{
  const map=new Map<string,MediaItem>();let duplicates=0;
  for(const item of items){const key=item.id.startsWith("upload:")?item.id:canonicalMediaUrl(item.originalUrl),prev=map.get(key);if(prev){duplicates++;if(item.score>prev.score)map.set(key,item)}else map.set(key,item)}
  return {items:[...map.values()],duplicates};
}
