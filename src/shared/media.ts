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
    const u=new URL(raw,location.href);
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
    return u.href.replace(/\/optimized\/(.+?)_\d+x\d+(?=\.[a-z]+$)/i,"/original/$1");
  }catch{return raw;}
}
