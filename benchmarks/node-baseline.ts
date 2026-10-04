import {performance} from "node:perf_hooks";
import {writeFile} from "node:fs/promises";
import {extractMediaFromHtml,dedupeMedia} from "../src/core/extract";
import {canonicalMediaUrl} from "../src/shared/media";
import {parsePreloadedDiscourseTopic} from "../src/core/discourse";
import {DEFAULT_SETTINGS,effectiveSettings} from "../src/shared/settings";
import type {MediaItem} from "../src/shared/media";

type Stats={n:number;min:number;max:number;mean:number;median:number;p95:number};
const round=(n:number)=>Math.round(n*1000)/1000;
function stats(values:number[]):Stats{
  const a=[...values].sort((x,y)=>x-y),sum=a.reduce((x,y)=>x+y,0);
  const at=(p:number)=>a[Math.min(a.length-1,Math.floor((a.length-1)*p))]??0;
  return {n:a.length,min:round(a[0]??0),max:round(a.at(-1)??0),mean:round(sum/a.length),median:round(at(.5)),p95:round(at(.95))};
}
async function bench(fn:()=>unknown|Promise<unknown>,iterations=30,warmup=5){
  for(let i=0;i<warmup;i++)await fn();
  const times:number[]=[];
  for(let i=0;i<iterations;i++){const t=performance.now();await fn();times.push(performance.now()-t)}
  return stats(times);
}
function htmlWithImages(count:number,quotedEvery=0){
  let body='<div class="cooked">';
  for(let i=0;i<count;i++){
    const block=`<div class="lightbox-wrapper"><a class="lightbox" href="https://files.example/original/4X/a/img${i}.jpeg" title="img ${i}"><img src="https://files.example/optimized/4X/a/img${i}_2_690x388.jpeg" data-base62-sha1="sha${i}" width="690" height="388"></a></div>`;
    body+=quotedEvery&&i%quotedEvery===0?`<aside class="quote">${block}</aside>`:block;
  }
  return body+'<img class="avatar" src="/a.png" width="48" height="48"><img class="emoji" src="/e.png" width="20" height="20"></div>';
}
function mediaItems(count:number,duplicateEvery=5):MediaItem[]{
  const out:MediaItem[]=[];
  for(let i=0;i<count;i++){
    const base=Math.floor(i/(duplicateEvery+1))*(duplicateEvery+1);
    const dup=i%(duplicateEvery+1)===duplicateEvery;
    const n=dup?base:i;
    out.push({id:`upload:sha${n}`,type:"image",originalUrl:`https://files.example/original/${n}.jpeg`,previewUrl:`https://files.example/optimized/${n}.jpeg`,sourceUrl:"https://forum.example/t/x/1",score:dup?.5:1});
  }
  return out;
}
function preloaded(postCount:number){
  const posts=Array.from({length:postCount},(_,i)=>({id:i+1,post_number:i+1,username:"u",cooked:`<p><img src="https://files.example/original/${i}.gif" width="480" height="372" class="animated"></p>`}));
  const topic={id:700,title:"Perf",post_stream:{stream:posts.map(p=>p.id),posts}};
  return `<!doctype html><script type="application/json" id="data-preloaded">${JSON.stringify({topic_700:JSON.stringify(topic)})}</script>`;
}
function memory(){const m=process.memoryUsage();return {rss:m.rss,heapUsed:m.heapUsed,heapTotal:m.heapTotal,external:m.external,arrayBuffers:m.arrayBuffers}}
async function main(){
  globalThis.gc?.();
  const before=memory();
  const results:any={generatedAt:new Date().toISOString(),runtime:process.version,microbenchmarks:{},memory:{before}};
  for(const count of [10,100,1000]){
    const html=htmlWithImages(count,7);
    results.microbenchmarks[`extract_${count}_images_ms`]=await bench(()=>extractMediaFromHtml(html,"https://forum.example/t/x/1",{},DEFAULT_SETTINGS),count===1000?12:30);
  }
  for(const count of [1000,10000]){
    const items=mediaItems(count);
    results.microbenchmarks[`dedupe_${count}_items_ms`]=await bench(()=>dedupeMedia(items),count===10000?15:40);
  }
  const urls=Array.from({length:10000},(_,i)=>`https://files.example/optimized/4X/a/hash${i}_2_690x388.jpeg?utm_source=x&keep=1#z`);
  results.microbenchmarks.canonicalize_10000_urls_ms=await bench(()=>{for(const u of urls)canonicalMediaUrl(u)},15);
  for(const count of [20,200,2000]){
    const html=preloaded(count);
    results.microbenchmarks[`preloaded_parse_${count}_posts_ms`]=await bench(()=>parsePreloadedDiscourseTopic(html,700),count===2000?12:30);
  }
  const profiles:Record<string,any>={};for(let i=0;i<1000;i++)profiles[`site${i}.example`]={hoverDelay:i};
  const settings={...DEFAULT_SETTINGS,siteProfiles:profiles};
  results.microbenchmarks.effective_settings_1000_profiles_ms=await bench(()=>{for(let i=0;i<1000;i++)effectiveSettings(settings,`https://site${i}.example/t/x/1`)},20);
  globalThis.gc?.();
  results.memory.after=memory();
  results.memory.delta={rss:results.memory.after.rss-before.rss,heapUsed:results.memory.after.heapUsed-before.heapUsed,external:results.memory.after.external-before.external,arrayBuffers:results.memory.after.arrayBuffers-before.arrayBuffers};
  const out=process.env.BASELINE_NODE_OUT||"baseline/node.json";
  await writeFile(out,JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
}
await main();
