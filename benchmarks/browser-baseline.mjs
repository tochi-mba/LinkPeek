import {chromium} from "@playwright/test";
import {createServer} from "node:http";
import {mkdtemp,rm,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {performance} from "node:perf_hooks";

const extensionPath=resolve("dist"),outPath=process.env.BASELINE_BROWSER_OUT||"baseline/browser.json";
let base="";let requestCount=0,responseBytes=0;
const animatedGif=Buffer.from("R0lGODlhBAAEAIEAANf/PwAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQICgAAACwAAAAABAAEAAAICQABCBxIsCCAgAAh+QQIDwAAACwAAAAABAAEAIH/d00AAAAAAAAAAAAICQABCBxIsCCAgAAh+QQIFAAAACwAAAAABAAEAIERFRIAAAAAAAAAAAAICQABCBxIsCCAgAA7","base64");
const round=n=>Math.round(n*1000)/1000;
function post(id,images=2){
  let cooked='<div class="cooked">';
  for(let j=0;j<images;j++)cooked+=`<a class="lightbox" href="${base}/media/original/${id}-${j}.jpeg"><img src="${base}/media/optimized/${id}-${j}_2_690x388.jpeg" data-base62-sha1="sha-${id}-${j}" width="690" height="388"></a>`;
  return {id,post_number:id,username:"u",post_url:`/t/topic/999/${id}`,cooked:cooked+"</div>"};
}
function topic(id,count,images=2){
  const posts=Array.from({length:Math.min(20,count)},(_,i)=>post(i+1,images));
  return {id,title:`Thread ${count}`,post_stream:{stream:Array.from({length:count},(_,i)=>i+1),posts}};
}
const topics=new Map([[101,topic(101,20)],[102,topic(102,100)],[103,topic(103,500)],[105,topic(105,500)],[106,topic(106,500)]]);
const topicDelay=id=>id===105?50:id===106?100:0;
const sendTopic=(id,res,body,type="application/json",status=200)=>{const delay=topicDelay(id);if(delay)setTimeout(()=>send(res,body,type,status),delay);else send(res,body,type,status)};for(let id=201;id<=212;id++)topics.set(id,topic(id,100));
function send(res,body,type="text/html",status=200){
  const b=Buffer.isBuffer(body)?body:Buffer.from(String(body));responseBytes+=b.byteLength;res.statusCode=status;res.setHeader("content-type",type);res.setHeader("content-length",String(b.byteLength));res.end(b);
}
const server=createServer((req,res)=>{
  requestCount++;const u=new URL(req.url||"/","http://x"),path=u.pathname;
  if(path==="/"){
    send(res,`<!doctype html><body>
      <a id="direct" href="${base}/media/direct.png">Direct</a>
      <a id="generic" href="${base}/generic">Generic</a>
      <a id="generic-large" href="${base}/generic-large">Generic large</a>
      <a id="small" href="${base}/t/small/101">Small</a>
      <a id="medium" href="${base}/t/medium/102">Medium</a>
      <a id="large" href="${base}/t/large/103">Large</a>
      <a id="slow50" href="${base}/t/slow50/105">Slow 50ms</a>
      <a id="slow100" href="${base}/t/slow100/106">Slow 100ms</a>
      <a id="fallback" href="${base}/t/fallback/104">Fallback</a>
      <a id="gif" href="${base}/media/perf.gif">GIF</a>
    </body>`);return;
  }
  if(path==="/prefetch"){
    const links=Array.from({length:12},(_,i)=>`<a href="${base}/t/prefetch-${i}/${201+i}">Topic ${i}</a>`).join("<br>");
    send(res,`<!doctype html><body>${links}</body>`);return;
  }
  if(path==="/generic"||path==="/generic-large"){
    const count=path==="/generic-large"?1000:200;
    let h="<title>Generic perf</title><main>";for(let i=0;i<count;i++)h+=`<img src="${base}/media/g-${i}.png" width="800" height="600">`;send(res,h+"</main>");return;
  }
  const topicJson=/\/t\/[^/]+\/(\d+)\.json$/.exec(path);
  if(topicJson){
    const id=Number(topicJson[1]);if(id===104){send(res,"blocked","text/plain",403);return}
    sendTopic(id,res,JSON.stringify(topics.get(id)),"application/json");return;
  }
  const postsJson=/\/t\/(\d+)\/posts\.json$/.exec(path);
  if(postsJson){
    const ids=u.searchParams.getAll("post_ids[]").map(Number);
    const topicId=Number(postsJson[1]);sendTopic(topicId,res,JSON.stringify({post_stream:{posts:ids.map(id=>post(id,2))}}),"application/json");return;
  }
  if(path==="/t/fallback/104"){
    const posts=Array.from({length:100},(_,i)=>post(i+1,2)),t={id:104,title:"Fallback 100",post_stream:{stream:posts.map(p=>p.id),posts}};
    const preload=JSON.stringify({topic_104:JSON.stringify(t)});
    send(res,`<!doctype html><meta name="generator" content="Discourse"><script type="application/json" id="data-preloaded">${preload}</script>`);return;
  }
  if(path==="/media/perf.gif"){send(res,animatedGif,"image/gif");return}
  if(path.startsWith("/media/")){send(res,'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',"image/svg+xml");return}
  send(res,"not found","text/plain",404);
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
base=`http://127.0.0.1:${server.address().port}`;

const profile=await mkdtemp(`${tmpdir()}/linkpeek-perf-`),results={generatedAt:new Date().toISOString(),browser:{},latency:{},network:{},memory:{},ui:{}};
let context;
try{
  const launchStart=performance.now();
  context=await chromium.launchPersistentContext(profile,{channel:"chromium",headless:true,args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`]});
  const sw=context.serviceWorkers()[0]??await context.waitForEvent("serviceworker");
  results.browser.launch_to_service_worker_ms=round(performance.now()-launchStart);
  const extensionId=new URL(sw.url()).host;
  await sw.evaluate(async()=>{const s=await chrome.storage.local.get("settings");await chrome.storage.local.set({settings:{...(s.settings??{}),prefetch:"off",showLearningTips:false}})});
  for(const p of context.pages())await p.close().catch(()=>{});
  const page=await context.newPage();
  const navStart=performance.now();await page.goto(base,{waitUntil:"domcontentloaded"});
  const domReady=performance.now();
  await page.waitForFunction(()=>Array.from(document.documentElement.children).some(n=>n.shadowRoot?.querySelector(".lp-root")));
  results.browser.navigation_domcontentloaded_ms=round(domReady-navStart);
  results.browser.content_host_after_dom_ms=round(performance.now()-domReady);
  results.browser.navigation_to_content_host_ms=round(performance.now()-navStart);
  const cdp=await context.newCDPSession(page);
  const heap=async()=>{const h=await cdp.send("Runtime.getHeapUsage");return {usedSize:h.usedSize,totalSize:h.totalSize,embedderHeapUsedSize:h.embedderHeapUsedSize,backingStorageSize:h.backingStorageSize}};
  results.memory.page_idle=await heap();

  async function patchSettings(patch){await sw.evaluate(async p=>{const s=await chrome.storage.local.get("settings");await chrome.storage.local.set({settings:{...(s.settings??{}),...p}})},patch);await page.waitForTimeout(80)}
  async function leave(){
    await page.evaluate(()=>{
      for(const a of document.querySelectorAll("a[href]"))a.dispatchEvent(new PointerEvent("pointerout",{bubbles:true,relatedTarget:document.body}));
    }).catch(()=>{});
    await page.keyboard.press("Escape").catch(()=>{});
    await page.waitForTimeout(60);
  }
  async function hoverMeasure(selector,expected,{resetNet=true,label=selector,resultTimeout=5000,beforeStart=null,progressExpected=null}={}){
    console.log("BASELINE_CASE_START",label,expected);
    await page.reload({waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some(n=>n.shadowRoot?.querySelector(".lp-root")));
    await leave();if(beforeStart)await beforeStart();if(resetNet){requestCount=0;responseBytes=0}
    const target=page.locator(selector),box=await target.boundingBox();if(!box)throw new Error(`No benchmark target for ${selector}`);
    const t=performance.now();
    await target.dispatchEvent("pointerover",{pointerType:"mouse",clientX:box.x+box.width/2,clientY:box.y+box.height/2,bubbles:true});
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some(n=>n.shadowRoot?.querySelector(".lp-panel")),null,{timeout:10000});
    const panel=performance.now()-t;
    let progress_ms=null;
    if(progressExpected){
      try{
        await page.waitForFunction(exp=>Array.from(document.documentElement.children).some(n=>n.shadowRoot?.textContent?.includes(exp)),progressExpected,{timeout:resultTimeout});
        progress_ms=round(performance.now()-t);
      }catch{}
    }
    let timedOut=false;
    try{
      await page.waitForFunction(exp=>Array.from(document.documentElement.children).some(n=>{
        const text=n.shadowRoot?.textContent||"";
        return text.includes(exp)||text.includes("Preview unavailable")
      }),expected,{timeout:resultTimeout});
    }catch{timedOut=true}
    const panelText=await page.evaluate(()=>Array.from(document.documentElement.children).map(n=>n.shadowRoot?.textContent||"").join("\n"));
    const ok=panelText.includes(expected);
    const measured={panel_ms:round(panel),progress_ms,result_ms:round(performance.now()-t),requests:requestCount,response_bytes:responseBytes,ok,timed_out:timedOut,panel_text:ok?undefined:panelText.slice(0,600)};
    console.log("BASELINE_CASE_DONE",label,JSON.stringify(measured));return measured;
  }
  await patchSettings({hoverDelay:300});
  const defaultHover=await hoverMeasure("#direct","1 media",{label:"default_hover_direct"});results.latency.default_hover_direct=defaultHover;
  await patchSettings({hoverDelay:0});
  for(const [name,selector,expected] of [
    ["direct","#direct","1 media"],["generic_200","#generic","200 media"],["generic_1000","#generic-large","1000 media"],
    ["discourse_20_posts","#small","40 media"],["discourse_100_posts","#medium","200 media"],
    ["discourse_500_posts","#large","1000 media",null],["discourse_500_posts_rtt50","#slow50","1000 media","40 media"],
    ["discourse_500_posts_rtt100","#slow100","1000 media","40 media"],["discourse_fallback_100_posts","#fallback","200 media",null]
  ]){
    const r=await hoverMeasure(selector,expected,{label:name,progressExpected});results.latency[name]=r;results.network[name]={requests:r.requests,response_bytes:r.response_bytes};
  }

  const cacheHit=await hoverMeasure("#small","40 media",{label:"discourse_20_posts_cache_hit"});
  results.latency.discourse_20_posts_cache_hit_ms=cacheHit.result_ms;
  results.network.discourse_20_posts_cache_hit={requests:cacheHit.requests,response_bytes:cacheHit.response_bytes};
  let t=performance.now();

  const gridSource=await hoverMeasure("#generic-large","1000 media",{label:"generic_1000_grid_source",beforeStart:async()=>{await cdp.send("HeapProfiler.collectGarbage").catch(()=>{});results.memory.before_large_focus=await heap()}});
  await cdp.send("HeapProfiler.collectGarbage").catch(()=>{});results.memory.after_large_focus=await heap();
  if(gridSource.ok){
    t=performance.now();
    await page.evaluate(()=>{const host=Array.from(document.documentElement.children).find(n=>n.shadowRoot?.querySelector(".lp-stage"));host?.shadowRoot?.querySelector(".lp-stage")?.dispatchEvent(new WheelEvent("wheel",{deltaY:100,bubbles:true,cancelable:true}))});
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some(n=>n.shadowRoot?.textContent?.includes("2 / 1000")));
    results.ui.focus_gesture_next_1000_ms=round(performance.now()-t);
    await page.evaluate(()=>{const host=Array.from(document.documentElement.children).find(n=>n.shadowRoot?.querySelector(".lp-stage"));host?.shadowRoot?.querySelector(".lp-stage")?.dispatchEvent(new WheelEvent("wheel",{deltaY:-100,bubbles:true,cancelable:true}))});
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some(n=>n.shadowRoot?.textContent?.includes("1 / 1000")));
    t=performance.now();
    await page.evaluate(()=>{const host=Array.from(document.documentElement.children).find(n=>n.shadowRoot?.querySelector(".lp-stage"));host?.shadowRoot?.querySelector(".lp-stage")?.dispatchEvent(new WheelEvent("wheel",{deltaY:100,bubbles:true,cancelable:true}))});
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some(n=>n.shadowRoot?.textContent?.includes("2 / 1000")));
    results.ui.gesture_clean_next_media_ms=round(performance.now()-t);
    await page.evaluate(()=>{const host=Array.from(document.documentElement.children).find(n=>n.shadowRoot?.querySelector(".lp-stage"));host?.shadowRoot?.querySelector(".lp-stage")?.dispatchEvent(new WheelEvent("wheel",{deltaY:-100,bubbles:true,cancelable:true}))});
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some(n=>n.shadowRoot?.textContent?.includes("1 / 1000")));

    requestCount=0;responseBytes=0;t=performance.now();
    await page.keyboard.press("g");
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some(n=>n.shadowRoot?.querySelector('.lp-grid[data-total="1000"]')&&n.shadowRoot.querySelectorAll(".lp-thumb").length>0),null,{timeout:15000});
    results.ui.grid_1000_render_ms=round(performance.now()-t);
    results.ui.grid_1000_dom_nodes=await page.evaluate(()=>Array.from(document.documentElement.children).reduce((m,n)=>Math.max(m,n.shadowRoot?.querySelectorAll(".lp-thumb").length||0),0));
    await cdp.send("HeapProfiler.collectGarbage").catch(()=>{});results.memory.after_grid_1000=await heap();
    await page.waitForTimeout(1200);
    results.network.grid_1000={requests:requestCount,response_bytes:responseBytes};
    await page.keyboard.press("g");
    t=performance.now();
    await page.evaluate(()=>{const host=Array.from(document.documentElement.children).find(n=>n.shadowRoot?.querySelector(".lp-stage"));host?.shadowRoot?.querySelector(".lp-stage")?.dispatchEvent(new WheelEvent("wheel",{deltaY:100,bubbles:true,cancelable:true}))});
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some(n=>n.shadowRoot?.textContent?.includes("2 / 1000")));
    results.ui.gesture_after_grid_ms=round(performance.now()-t);
  }else{
    results.ui.grid_1000_render_ms=null;
    results.ui.gesture_clean_next_media_ms=null;
    results.ui.gesture_after_grid_ms=null;
    results.network.grid_1000={requests:0,response_bytes:0};
    results.memory.after_grid_1000=results.memory.after_large_focus;
  }
  await leave();await cdp.send("HeapProfiler.collectGarbage").catch(()=>{});results.memory.after_close_gc=await heap();

  await patchSettings({gifAutoplay:"never"});await page.reload({waitUntil:"domcontentloaded"});await page.waitForFunction(()=>Array.from(document.documentElement.children).some(n=>n.shadowRoot?.querySelector(".lp-root")));
  await cdp.send("HeapProfiler.collectGarbage").catch(()=>{});results.memory.before_gif_decode=await heap();
  t=performance.now();await page.locator("#gif").hover();await page.waitForFunction(()=>Array.from(document.documentElement.children).some(n=>n.shadowRoot?.querySelector(".lp-gif-controls")),null,{timeout:10000});
  results.latency.gif_hover_to_controls_ms=round(performance.now()-t);await cdp.send("HeapProfiler.collectGarbage").catch(()=>{});results.memory.after_gif_decode=await heap();
  const timeline=page.locator(".lp-gif-timeline");t=performance.now();for(let i=0;i<20;i++)await page.locator(".lp-gif-next").click();results.ui.gif_20_frame_steps_ms=round(performance.now()-t);
  await leave();

  await patchSettings({prefetch:"nearby",maxRequests:3});
  requestCount=0;responseBytes=0;const prefetchPage=await context.newPage();t=performance.now();await prefetchPage.goto(`${base}/prefetch`);await prefetchPage.waitForTimeout(3500);
  results.network.default_nearby_prefetch_12_threads={requests:requestCount,response_bytes:responseBytes,window_ms:round(performance.now()-t)};
  await prefetchPage.close();

  for(const [name,path,ready] of [["options","options.html",'#search'],["popup","popup.html",'#enabled'],["onboarding","onboarding.html",'.screen.active']]){
    const p=await context.newPage(),start=performance.now();await p.goto(`chrome-extension://${extensionId}/${path}`);await p.locator(ready).waitFor();results.ui[`${name}_startup_ms`]=round(performance.now()-start);
    if(name==="options"){const input=p.locator("#search");const s=performance.now();await input.fill("gif");await p.locator('[data-section="Media Types"]').waitFor();results.ui.options_search_gif_ms=round(performance.now()-s)}
    await p.close();
  }
  results.memory.deltas={
    large_focus_used:results.memory.after_large_focus.usedSize-results.memory.before_large_focus.usedSize,
    grid_1000_incremental_used:results.memory.after_grid_1000.usedSize-results.memory.after_large_focus.usedSize,
    grid_1000_total_used:results.memory.after_grid_1000.usedSize-results.memory.before_large_focus.usedSize,
    after_close_gc_used:results.memory.after_close_gc.usedSize-results.memory.before_large_focus.usedSize,
    gif_decode_used:results.memory.after_gif_decode.usedSize-results.memory.before_gif_decode.usedSize
  };
  await mkdir(resolve(outPath,".."),{recursive:true}).catch(()=>{});
  await writeFile(outPath,JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
}finally{
  await context?.close().catch(()=>{});await rm(profile,{recursive:true,force:true});await new Promise(r=>server.close(r));
}
