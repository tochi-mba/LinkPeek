import {test,expect,chromium,type BrowserContext,type Page} from "@playwright/test";
import {createServer,type Server} from "node:http";
import {type AddressInfo} from "node:net";
import {resolve} from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";

let server:Server;let base:string;
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
    const path=req.url||"/";
    if(path==="/"){
      res.setHeader("content-type","text/html");
      res.end(`<!doctype html><html><body style="font-family:sans-serif"><a id="topic" href="/t/demo/123">Demo thread</a> · <a id="fallback" href="/t/fallback/456">Fallback thread</a></body></html>`);return;
    }
    if(path==="/t/demo/123.json"){res.setHeader("content-type","application/json");res.end(JSON.stringify(demoTopic()));return}
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
