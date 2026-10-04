export type LinkKind="direct-image"|"direct-video"|"discourse"|"generic"|"anchor"|"download"|"ignored";
export interface MediaItem{
  id:string; type:"image"|"gif"|"video"; originalUrl:string; previewUrl:string; sourceUrl:string;
  filename?:string; width?:number; height?:number; postNumber?:number; postId?:number; author?:string;
  quoted?:boolean; score:number;
}
export interface ScanResult{
  url:string; kind:LinkKind; title?:string; items:MediaItem[]; complete:boolean; postsScanned?:number; totalPosts?:number;
  diagnostics?:{ignored:number;duplicates:number;adapter:string;warnings:string[]};
}
export function classifyLink(raw:string):LinkKind{
  try{
    const u=new URL(raw,typeof location!=="undefined"?location.href:"https://example.test/");
    if(u.hash&&u.origin===location.origin&&u.pathname===location.pathname&&u.search===location.search)return "anchor";
    if(/\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i.test(u.href))return "direct-image";
    if(/\.(?:mp4|webm|mov)(?:$|[?#])/i.test(u.href))return "direct-video";
    if(/\/t\/[^/]+\/\d+(?:\/\d+)?\/?$/.test(u.pathname)||/\/t\/\d+/.test(u.pathname))return "discourse";
    if(/\.(?:zip|pdf|exe|dmg|pkg)(?:$|[?#])/i.test(u.href))return "download";
    if(!/^https?:$/.test(u.protocol))return "ignored";
    return "generic";
  }catch{return "ignored";}
}
export function canonicalMediaUrl(raw:string){
  try{
    const u=new URL(raw);
    u.hash="";
    for(const k of [...u.searchParams.keys()]) if(/^utm_|^(fbclid|gclid)$/i.test(k))u.searchParams.delete(k);
    if(u.pathname.includes("/optimized/")){
      u.pathname=u.pathname
        .replace("/optimized/","/original/")
        .replace(/_\d+_\d+x\d+(\.[a-z0-9]+)$/i,"$1")
        .replace(/_\d+x\d+(\.[a-z0-9]+)$/i,"$1");
    }
    return u.href;
  }catch{return raw;}
}

export function uniqueMediaItems(items:MediaItem[]):{items:MediaItem[];duplicates:number}{
  const out:MediaItem[]=[];const byIdentity=new Map<string,number>();let duplicates=0;
  const keys=(item:MediaItem)=>{
    const set=new Set<string>();
    if(item.id)set.add(`id:${item.id}`);
    set.add(`original:${canonicalMediaUrl(item.originalUrl)}`);
    set.add(`preview:${canonicalMediaUrl(item.previewUrl)}`);
    return [...set];
  };
  for(const item of items){
    const identity=keys(item),existing=identity.map(k=>byIdentity.get(k)).find((n):n is number=>n!==undefined);
    if(existing!==undefined){
      duplicates++;
      if(item.score>out[existing].score)out[existing]=item;
      for(const key of identity)byIdentity.set(key,existing);
      continue;
    }
    const index=out.length;out.push(item);for(const key of identity)byIdentity.set(key,index);
  }
  return {items:out,duplicates};
}
