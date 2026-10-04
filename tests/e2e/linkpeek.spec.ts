import {test,expect,chromium,type BrowserContext,type Page} from "@playwright/test";
import {createServer,type Server} from "node:http";
import {type AddressInfo} from "node:net";
import {resolve} from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";

let server:Server;let base:string;let slowBatchRequests=0,prefetchTopicRequests=0,prefetchBatchRequests=0,sharedTopicRequests=0,sharedBatchRequests=0;
const extensionPath=resolve("dist");
const animatedGif=Buffer.from("R0lGODlhBAAEAIEAANf/PwAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQICgAAACwAAAAABAAEAAAICQABCBxIsCCAgAAh+QQIDwAAACwAAAAABAAEAIH/d00AAAAAAAAAAAAICQABCBxIsCCAgAAh+QQIFAAAACwAAAAABAAEAIERFRIAAAAAAAAAAAAICQABCBxIsCCAgAA7","base64");

async function launchExtension():Promise<{context:BrowserContext;profile:string}>{
  const profile=await mkdtemp(`${tmpdir()}/linkpeek-e2e-`);
  try{
    const context=await chromium.launchPersistentContext(profile,{
      channel:"chromium",headless:true,
      args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`]
    });
    await Promise.race([
      context.serviceWorkers().length?Promise.resolve():context.waitForEvent("serviceworker"),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error("LinkPeek service worker did not start")),12_000))
    ]);
    return {context,profile};
  }catch(error){await rm(profile,{recursive:true,force:true});throw error}
}
async function closeExtension(context:BrowserContext,profile:string){
  await Promise.race([context.close(),new Promise<void>(resolve=>setTimeout(resolve,5_000))]);
  await rm(profile,{recursive:true,force:true});
}
async function wheelStage(page:Page,deltaY:number){
  await page.evaluate(delta=>{
    const host=Array.from(document.documentElement.children).find((n:any)=>n.shadowRoot?.querySelector(".lp-stage")) as any;
    host?.shadowRoot?.querySelector(".lp-stage")?.dispatchEvent(new WheelEvent("wheel",{deltaY:delta,bubbles:true,cancelable:true}));
  },deltaY);
  await page.waitForTimeout(180);
}
function perfPost(id:number,topicId=789){return {id,post_number:id,username:"perf",post_url:`/t/perf/${topicId}/${id}`,cooked:`<img src="${base}/media/perf-${topicId}-${id}.jpg" data-base62-sha1="perf-${topicId}-${id}" width="800" height="600">`}}
function perfTopic(id:number,count=100){return {id,title:`Perf ${id}`,post_stream:{stream:Array.from({length:count},(_,i)=>i+1),posts:Array.from({length:Math.min(20,count)},(_,i)=>perfPost(i+1,id))}}}
function demoTopic(){
  return {id:123,title:"Demo thread",post_stream:{stream:[1],posts:[{id:1,post_number:1,username:"rex",post_url:"/t/demo/123/1",cooked:`<div class="cooked">
    <a class="lightbox" href="${base}/media/original/4X/a/hash1.jpeg" title="Original one"><img src="${base}/media/optimized/4X/a/hash1_2_690x388.jpeg" data-base62-sha1="imageOne" width="690" height="388"></a>
    <a class="lightbox" href="${base}/media/original/4X/b/hash2.jpeg" title="Original two"><img src="${base}/media/optimized/4X/b/hash2_2_690x388.jpeg" data-base62-sha1="imageTwo" width="690" height="388"></a>
    <aside class="quote"><img src="${base}/media/original/quoted.gif" data-base62-sha1="quotedGif" width="480" height="372" class="animated"></aside>
    <img src="${base}/media/anim.gif" data-base62-sha1="animatedGif" width="480" height="372" class="animated" alt="Animated fixture">
    <img class="avatar" src="${base}/media/avatar.png" width="48" height="48">
    <img class="emoji" src="${base}/media/emoji.png" width="20" height="20">
  </div>`}]}};
}

test.beforeAll(async()=>{
  server=createServer((req,res)=>{
    const requestUrl=new URL(req.url||"/",base||"http://127.0.0.1"),path=requestUrl.pathname;
    if(path==="/"){
      res.setHeader("content-type","text/html");
      res.end(`<!doctype html><html><body style="font-family:sans-serif"><a id="topic" href="/t/demo/123">Demo thread</a> · <a id="fallback" href="/t/fallback/456">Fallback thread</a> · <a id="large" href="/t/large/789">Large thread</a> · <a id="slow" href="/t/slow/790">Slow thread</a> · <a id="shared" href="/t/shared/791">Shared thread</a></body></html>`);return;
    }
    if(path==="/prefetch"){res.setHeader("content-type","text/html");res.end(`<!doctype html><body>${Array.from({length:6},(_,i)=>`<a href="/t/prefetch-${i}/${800+i}">P${i}</a>`).join("<br>")}</body>`);return}
    if(path==="/t/demo/123.json"){res.setHeader("content-type","application/json");res.end(JSON.stringify(demoTopic()));return}
    if(path==="/t/large/789.json"){res.setHeader("content-type","application/json");res.end(JSON.stringify(perfTopic(789)));return}
    if(path==="/t/789/posts.json"){
      const ids=requestUrl.searchParams.getAll("post_ids[]").map(Number);
      setTimeout(()=>{if(!res.writableEnded){res.setHeader("content-type","application/json");res.end(JSON.stringify({post_stream:{posts:ids.map(id=>perfPost(id,789))}}))}},250);return;
    }
    if(path==="/t/slow/790.json"){setTimeout(()=>{if(!res.writableEnded){res.setHeader("content-type","application/json");res.end(JSON.stringify(perfTopic(790))) }},400);return}
    if(path==="/t/790/posts.json"){slowBatchRequests++;res.setHeader("content-type","application/json");res.end(JSON.stringify({post_stream:{posts:[]}}));return}
    if(path==="/t/shared/791.json"){sharedTopicRequests++;setTimeout(()=>{if(!res.writableEnded){res.setHeader("content-type","application/json");res.end(JSON.stringify(perfTopic(791))) }},100);return}
    if(path==="/t/791/posts.json"){
      sharedBatchRequests++;const ids=requestUrl.searchParams.getAll("post_ids[]").map(Number);
      setTimeout(()=>{if(!res.writableEnded){res.setHeader("content-type","application/json");res.end(JSON.stringify({post_stream:{posts:ids.map(id=>perfPost(id,791))}}))}},100);return;
    }
    if(/^\/t\/prefetch-\d+\/80\d\.json$/.test(path)){prefetchTopicRequests++;const id=Number(/(80\d)\.json$/.exec(path)![1]);res.setHeader("content-type","application/json");res.end(JSON.stringify(perfTopic(id)));return}
    if(/^\/t\/80\d\/posts\.json$/.test(path)){prefetchBatchRequests++;res.setHeader("content-type","application/json");res.end(JSON.stringify({post_stream:{posts:[]}}));return}
    if(path==="/t/fallback/456.json"){res.statusCode=403;res.end("blocked");return}
    if(path==="/t/fallback/456"){
      const topic={id:456,title:"Embedded topic",post_stream:{stream:[9],posts:[{id:9,post_number:29,username:"fixture",post_url:"/t/fallback/456/29",cooked:`<p><img src="${base}/media/original/fallback.gif" data-base62-sha1="fallbackGif" width="480" height="372" class="animated"></p>`}]}};
      const preload=JSON.stringify({topic_456:JSON.stringify(topic)});
      res.setHeader("content-type","text/html");res.end(`<!doctype html><meta name="generator" content="Discourse 2026"><script type="application/json" id="data-preloaded">${preload}</script>`);return;
    }
    if(path==="/media/anim.gif"||path==="/media/original/fallback.gif"||path==="/media/original/quoted.gif"){res.setHeader("content-type","image/gif");res.end(animatedGif);return}
    if(path.startsWith("/media/")){res.setHeader("content-type","image/svg+xml");res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="690" height="388"><rect width="100%" height="100%" fill="#181E19"/><circle cx="345" cy="194" r="100" fill="#D7FF3F"/></svg>`);return}
    res.statusCode=404;res.end("not found");
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async()=>{if(server?.listening)await new Promise<void>(r=>server.close(()=>r()))});

test("Discourse hover filters page chrome and opens the whole-thread viewer",async()=>{
  const {context,profile}=await launchExtension();
  try{
    const page=await context.newPage();await page.goto(base);await page.locator("#topic").hover();
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some((n:any)=>n.shadowRoot?.textContent?.includes("Demo thread")),null,{timeout:12_000});
    const snapshot=await page.evaluate(()=>Array.from(document.documentElement.children).map((n:any)=>n.shadowRoot?.textContent||"").join("\n"));
    expect(snapshot).toContain("3 media");expect(snapshot).toContain("Demo thread");expect(snapshot).not.toContain("avatar");expect(snapshot).not.toContain("quotedGif");
    await wheelStage(page,100);await page.waitForFunction(()=>Array.from(document.documentElement.children).some((n:any)=>n.shadowRoot?.textContent?.includes("2 / 3")));
    await page.keyboard.press("g");await page.waitForFunction(()=>Array.from(document.documentElement.children).some((n:any)=>n.shadowRoot?.querySelector(".lp-grid")));
    await page.keyboard.press("g");await page.keyboard.press("?");await page.waitForFunction(()=>Array.from(document.documentElement.children).some((n:any)=>n.shadowRoot?.textContent?.includes("One-hand controls")));
  }finally{await closeExtension(context,profile)}
});

test("GIF player supports playback, frame stepping, scrubbing, speed, looping and zoom",async()=>{
  const {context,profile}=await launchExtension();
  try{
    const sw=context.serviceWorkers()[0];expect(sw).toBeTruthy();
    await sw.evaluate(async()=>{
      const stored=await chrome.storage.local.get("settings");
      await chrome.storage.local.set({settings:{...(stored.settings??{}),gifAutoplay:"never"}});
    });
    const page=await context.newPage();await page.goto(base);await page.locator("#topic").hover();
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some((n:any)=>n.shadowRoot?.textContent?.includes("3 media")),null,{timeout:12_000});
    await wheelStage(page,100);await wheelStage(page,100);
    await expect(page.locator(".lp-gif-controls")).toBeVisible({timeout:12_000});
    const timeline=page.locator(".lp-gif-timeline");await expect(timeline).toHaveAttribute("max","2");
    await expect(page.locator(".lp-gif-toggle")).toHaveAttribute("aria-label","Play GIF");
    await timeline.evaluate((el:HTMLInputElement)=>{el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}))});
    await expect(timeline).toHaveValue("0");
    await page.locator(".lp-gif-next").click();await expect(timeline).toHaveValue("1");
    await page.locator(".lp-gif-prev").click();await expect(timeline).toHaveValue("0");
    await page.locator(".lp-gif-speed").selectOption("2");await expect(page.locator(".lp-gif-speed")).toHaveValue("2");
    await page.locator(".lp-gif-loop").click();await expect(page.locator(".lp-gif-loop")).toHaveAttribute("aria-pressed","false");
    await page.keyboard.press("Space");await expect(page.locator(".lp-gif-toggle")).toHaveAttribute("aria-label","Pause GIF");await page.keyboard.press("Space");
    await page.keyboard.press(".");await expect(timeline).toHaveValue("1");
    await timeline.dispatchEvent("wheel",{deltaX:120,bubbles:true,cancelable:true});await expect(timeline).toHaveValue("2");
    await page.locator(".lp-gif-canvas").dblclick({position:{x:2,y:2}});
    await expect(page.locator(".lp-gif-canvas")).toHaveAttribute("style",/scale\(/);
    await page.keyboard.press("?");await expect(page.getByText("Previous / next GIF frame",{exact:true})).toBeVisible();
  }finally{await closeExtension(context,profile)}
});

test("Discourse falls back to embedded data-preloaded topic payloads",async()=>{
  const {context,profile}=await launchExtension();
  try{
    const page=await context.newPage();await page.goto(base);await page.locator("#fallback").hover();
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some((n:any)=>n.shadowRoot?.textContent?.includes("Embedded topic")),null,{timeout:12_000});
    const snapshot=await page.evaluate(()=>Array.from(document.documentElement.children).map((n:any)=>n.shadowRoot?.textContent||"").join("\n"));
    expect(snapshot).toContain("1 media");expect(snapshot).toContain("Post #29");
  }finally{await closeExtension(context,profile)}
});


test("optimization paths stream early results, virtualize grid and cancel abandoned scans",async()=>{
  const {context,profile}=await launchExtension();
  try{
    const sw=context.serviceWorkers()[0];expect(sw).toBeTruthy();
    await sw.evaluate(async()=>{const stored=await chrome.storage.local.get("settings");await chrome.storage.local.set({settings:{...(stored.settings??{}),hoverDelay:0,prefetch:"off",continueAfterClose:"no",batchSize:50,maxRequests:3}})});
    const page=await context.newPage();await page.goto(base);
    await page.locator("#large").hover();
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some((n:any)=>n.shadowRoot?.textContent?.includes("20 media")),null,{timeout:1500});
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some((n:any)=>n.shadowRoot?.textContent?.includes("100 media")),null,{timeout:5000});
    await page.keyboard.press("g");
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some((n:any)=>{const count=n.shadowRoot?.querySelectorAll(".lp-thumb").length??0;return count>0&&count<80}));
    const rendered=await page.evaluate(()=>Math.max(...Array.from(document.documentElement.children).map((n:any)=>n.shadowRoot?.querySelectorAll(".lp-thumb").length??0)));
    expect(rendered).toBeLessThan(80);
    await page.evaluate(()=>{const host=Array.from(document.documentElement.children).find((n:any)=>n.shadowRoot?.querySelector(".lp-grid")) as any;const grid=host.shadowRoot.querySelector(".lp-grid");grid.scrollTop=grid.scrollHeight;grid.dispatchEvent(new Event("scroll"))});
    await page.waitForFunction(()=>Array.from(document.documentElement.children).some((n:any)=>n.shadowRoot?.querySelector('.lp-thumb[data-i="99"]')));

    await page.keyboard.press("Escape");slowBatchRequests=0;await page.goto(base);
    await page.locator("#slow").hover();await page.waitForTimeout(60);await page.mouse.move(1,1);await page.waitForTimeout(700);
    expect(slowBatchRequests).toBe(0);
  }finally{await closeExtension(context,profile)}
});

test("same-URL scans are shared and nearby prefetch stays shallow",async()=>{
  const first=await launchExtension();
  try{
    const sw=first.context.serviceWorkers()[0];expect(sw).toBeTruthy();
    await sw.evaluate(async()=>{const stored=await chrome.storage.local.get("settings");await chrome.storage.local.set({settings:{...(stored.settings??{}),hoverDelay:0,prefetch:"off",batchSize:50,maxRequests:3}})});
    sharedTopicRequests=0;sharedBatchRequests=0;
    const p1=await first.context.newPage(),p2=await first.context.newPage();await Promise.all([p1.goto(base),p2.goto(base)]);
    await Promise.all([p1.locator("#shared").hover(),p2.locator("#shared").hover()]);
    await Promise.all([
      p1.waitForFunction(()=>Array.from(document.documentElement.children).some((n:any)=>n.shadowRoot?.textContent?.includes("100 media")),null,{timeout:5000}),
      p2.waitForFunction(()=>Array.from(document.documentElement.children).some((n:any)=>n.shadowRoot?.textContent?.includes("100 media")),null,{timeout:5000})
    ]);
    expect(sharedTopicRequests).toBe(1);expect(sharedBatchRequests).toBe(2);
  }finally{await closeExtension(first.context,first.profile)}

  const second=await launchExtension();
  try{
    const sw=second.context.serviceWorkers()[0];await sw.evaluate(async()=>{const stored=await chrome.storage.local.get("settings");await chrome.storage.local.set({settings:{...(stored.settings??{}),prefetch:"nearby",maxRequests:3}})});
    prefetchTopicRequests=0;prefetchBatchRequests=0;
    const page=await second.context.newPage();await page.goto(base+"/prefetch");await page.waitForTimeout(3000);
    expect(prefetchTopicRequests).toBeGreaterThan(0);expect(prefetchTopicRequests).toBeLessThanOrEqual(2);expect(prefetchBatchRequests).toBe(0);
  }finally{await closeExtension(second.context,second.profile)}
});

test("onboarding and settings render and persist GIF customization",async()=>{
  const {context,profile}=await launchExtension();
  try{
    const sw=context.serviceWorkers()[0];expect(sw).toBeTruthy();const id=new URL(sw.url()).host;const page=await context.newPage();
    await page.goto(`chrome-extension://${id}/onboarding.html`);await expect(page.getByText("See what’s behind a link")).toBeVisible();
    await page.goto(`chrome-extension://${id}/options.html`);await expect(page.getByPlaceholder(/Search settings/)).toBeVisible();await expect(page.getByRole("heading",{name:"Gestures",exact:true})).toBeVisible();
    const delay=page.locator('[data-key="hoverDelay"]');await delay.fill("75");await delay.press("Tab");
    const maxGif=page.locator('[data-key="gifDecodeMaxMb"]');await maxGif.fill("24");await maxGif.press("Tab");
    await page.reload();await expect(page.locator('[data-key="hoverDelay"]')).toHaveValue("75");await expect(page.locator('[data-key="gifDecodeMaxMb"]')).toHaveValue("24");
    await page.goto(`chrome-extension://${id}/popup.html`);await expect(page.getByText("LinkPeek",{exact:true})).toBeVisible();
  }finally{await closeExtension(context,profile)}
});
