import type {MediaItem} from "../shared/media";
import type {LinkPeekSettings} from "../shared/settings";

export type PreloadPlan={priority:number[];background:number[];originals:number[]};

function uniqueValid(values:number[],length:number){
  const seen=new Set<number>(),out:number[]=[];
  for(const n of values){if(n<0||n>=length||seen.has(n))continue;seen.add(n);out.push(n)}
  return out;
}
export function buildPreloadPlan(length:number,index:number,settings:Pick<LinkPeekSettings,"preloadNext"|"preloadPrevious"|"preloadRest"|"preloadRestLimit"|"preloadOriginals"|"networkMode">):PreloadPlan{
  if(length<=0)return {priority:[],background:[],originals:[]};
  const dataSaver=settings.networkMode==="data";
  const ahead=dataSaver?Math.min(1,settings.preloadNext):Math.max(0,settings.preloadNext);
  const behind=dataSaver?Math.min(1,settings.preloadPrevious):Math.max(0,settings.preloadPrevious);
  const priority:number[]=[];
  for(let d=1;d<=Math.max(ahead,behind);d++){if(d<=ahead)priority.push(index+d);if(d<=behind)priority.push(index-d)}
  const cleanPriority=uniqueValid(priority,length);
  let background:number[]=[];
  const allowRest=!dataSaver&&settings.preloadRest!=="off"&&(settings.preloadRestLimit<=0||length<=settings.preloadRestLimit);
  if(allowRest){
    const used=new Set([index,...cleanPriority]);
    const rest:number[]=[];
    for(let d=1;d<length;d++){const forward=index+d,back=index-d;if(forward<length&&!used.has(forward)){used.add(forward);rest.push(forward)}if(back>=0&&!used.has(back)){used.add(back);rest.push(back)}}
    background=rest;
  }
  let originals:number[]=[];
  if(settings.preloadOriginals==="next")originals=uniqueValid([index+1],length);
  else if(settings.preloadOriginals==="three")originals=uniqueValid([index+1,index+2,index+3],length);
  else if(settings.preloadOriginals==="aggressive")originals=uniqueValid([...cleanPriority,...background],length);
  return {priority:cleanPriority,background,originals};
}

type Entry={img:HTMLImageElement;promise:Promise<void>;ready:boolean;failed:boolean;lastUsed:number};
type Task={url:string;priority:number;generation:number};

export class MediaPreloader{
  private entries=new Map<string,Entry>();private queue:Task[]=[];private active=0;private generation=0;private idleHandle:number|undefined;
  private items:MediaItem[]=[];private settings?:LinkPeekSettings;private index=0;
  reset(items:MediaItem[],index:number,settings:LinkPeekSettings){
    this.items=items;this.settings=settings;this.index=index;this.generation++;this.queue=[];if(this.idleHandle!=null){window.cancelIdleCallback?.(this.idleHandle);this.idleHandle=undefined}
    this.schedule(index);
    this.prune();
  }
  schedule(index:number){
    if(!this.settings||!this.items.length)return;this.index=index;const gen=this.generation,plan=buildPreloadPlan(this.items.length,index,this.settings);
    for(const n of plan.priority)this.enqueuePreview(this.items[n],0,gen);
    for(const n of plan.originals)this.enqueueOriginal(this.items[n],1,gen);
    this.pump();
    if(plan.background.length){
      const run=()=>{this.idleHandle=undefined;for(const n of plan.background)this.enqueuePreview(this.items[n],3,gen);this.pump()};
      if(this.settings.preloadRest==="all")run();
      else if(typeof requestIdleCallback==="function")this.idleHandle=requestIdleCallback(run,{timeout:1200});
      else window.setTimeout(run,180);
    }
  }
  async ensure(item:MediaItem){
    if(item.type==="gif"){
      await chrome.runtime.sendMessage({type:"LINKPEEK_PREFETCH_BINARY",url:item.originalUrl,maxMb:this.settings?.gifDecodeMaxMb??32}).catch(()=>{});
      return;
    }
    const entry=this.load(item.previewUrl,0,this.generation);await entry.promise;
  }
  isReady(item:MediaItem){return item.type==="gif"||this.entries.get(item.previewUrl)?.ready===true}
  element(item:MediaItem){
    const entry=this.entries.get(item.previewUrl);if(!entry?.ready)return undefined;entry.lastUsed=performance.now();return entry.img
  }
  dispose(){this.generation++;this.queue=[];this.items=[];if(this.idleHandle!=null){window.cancelIdleCallback?.(this.idleHandle);this.idleHandle=undefined}this.entries.clear()}
  private enqueuePreview(item:MediaItem,priority:number,generation:number){
    if(item.type==="gif"){void chrome.runtime.sendMessage({type:"LINKPEEK_PREFETCH_BINARY",url:item.originalUrl,maxMb:this.settings?.gifDecodeMaxMb??32}).catch(()=>{});return}
    this.enqueue(item.previewUrl,priority,generation);
  }
  private enqueueOriginal(item:MediaItem,priority:number,generation:number){
    if(!item.originalUrl||item.originalUrl===item.previewUrl)return;
    if(item.type==="gif"&&this.settings?.preloadOriginals!=="aggressive")return;
    this.enqueue(item.originalUrl,priority,generation);
  }
  private enqueue(url:string,priority:number,generation:number){
    if(this.entries.has(url)||this.queue.some(t=>t.url===url))return;this.queue.push({url,priority,generation});this.queue.sort((a,b)=>a.priority-b.priority);
  }
  private load(url:string,priority:number,generation:number){
    const existing=this.entries.get(url);if(existing){existing.lastUsed=performance.now();return existing}
    const img=new Image();img.decoding="async";(img as HTMLImageElement&{fetchPriority?:"high"|"low"|"auto"}).fetchPriority=priority===0?"high":"low";
    const entry:Entry={img,promise:Promise.resolve(),ready:false,failed:false,lastUsed:performance.now()};
    entry.promise=new Promise<void>(resolve=>{
      const done=async(ok:boolean)=>{entry.failed=!ok;if(ok){try{await img.decode()}catch{}entry.ready=true}resolve()};
      img.addEventListener("load",()=>void done(true),{once:true});img.addEventListener("error",()=>void done(false),{once:true});img.src=url;
    });
    this.entries.set(url,entry);return entry;
  }
  private pump(){
    if(!this.settings)return;const max=Math.max(1,Math.min(8,this.settings.preloadConcurrency));
    while(this.active<max&&this.queue.length){
      const task=this.queue.shift()!;if(task.generation!==this.generation)continue;this.active++;
      this.load(task.url,task.priority,task.generation).promise.finally(()=>{this.active--;this.pump()});
    }
  }
  private prune(){
    const max=Math.max(24,(this.settings?.preloadRestLimit??120)+12);if(this.entries.size<=max)return;
    const keep=new Set<string>();
    for(const item of this.items.slice(Math.max(0,this.index-(this.settings?.preloadPrevious??2)-3),this.index+(this.settings?.preloadNext??4)+4)){keep.add(item.previewUrl);keep.add(item.originalUrl)}
    const candidates=[...this.entries.entries()].filter(([url])=>!keep.has(url)).sort((a,b)=>a[1].lastUsed-b[1].lastUsed);
    for(const [url] of candidates){if(this.entries.size<=max)break;this.entries.delete(url)}
  }
}
