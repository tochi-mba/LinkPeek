import {test,expect,chromium,Page} from "@playwright/test";
import {createServer,Server} from "node:http";
import {AddressInfo} from "node:net";
import {resolve} from "node:path";

let server:Server;let base:string;
test.beforeAll(async()=>{
  server=createServer((req,res)=>{
    const path=req.url||"/";
    if(path==="/"){
      res.setHeader("content-type","text/html");
      res.end(`<!doctype html><html><body style="font-family:sans-serif"><a id="topic" href="/t/demo/123">Demo thread</a></body></html>`);return;
    }
    if(path==="/t/demo/123.json"){
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({id:123,title:"Demo thread",post_stream:{stream:[1],posts:[{id:1,post_number:1,username:"rex",cooked:`<div class="cooked"><a class="lightbox" href="${base}/media/original.jpg" title="Original"><img src="${base}/media/preview.jpg" width="690" height="388"></a><img class="avatar" src="${base}/media/avatar.png" width="48" height="48"></div>`}]}}));return;
    }
    if(path.startsWith("/media/")){res.setHeader("content-type","image/svg+xml");res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="690" height="388"><rect width="100%" height="100%" fill="#181E19"/><circle cx="345" cy="194" r="100" fill="#D7FF3F"/></svg>`);return}
    res.statusCode=404;res.end("not found");
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()))});

test("hovering a Discourse link opens a filtered whole-thread media viewer",async()=>{
  const path=resolve("dist");
  const context=await chromium.launchPersistentContext("",{headless:true,args:[`--disable-extensions-except=${path}`,`--load-extension=${path}`]});
  const workers=context.serviceWorkers();if(!workers.length)await context.waitForEvent("serviceworker");
  const page=await context.newPage();await page.goto(base);
  await page.locator("#topic").hover();
  await page.waitForFunction(()=>document.querySelector("div")!==null);
  await page.waitForFunction(()=>[...document.documentElement.children].some((n:any)=>n.shadowRoot?.textContent?.includes("Demo thread")),null,{timeout:10_000});
  const snapshot=await page.evaluate(()=>[...document.documentElement.children].map((n:any)=>n.shadowRoot?.textContent||"").join("\n"));
  expect(snapshot).toContain("1 media");
  expect(snapshot).toContain("Demo thread");
  expect(snapshot).not.toContain("avatar");
  await page.keyboard.press("?");
  const help=await page.evaluate(()=>[...document.documentElement.children].map((n:any)=>n.shadowRoot?.textContent||"").join("\n"));
  expect(help).toContain("One-hand controls");
  await context.close();
});

test("onboarding and settings pages render",async()=>{
  const path=resolve("dist");const context=await chromium.launchPersistentContext("",{headless:true,args:[`--disable-extensions-except=${path}`,`--load-extension=${path}`]});
  const sw=context.serviceWorkers()[0]??await context.waitForEvent("serviceworker");const id=new URL(sw.url()).host;
  const page=await context.newPage();await page.goto(`chrome-extension://${id}/onboarding.html`);await expect(page.getByText("See what’s behind a link")).toBeVisible();
  await page.goto(`chrome-extension://${id}/options.html`);await expect(page.getByPlaceholder(/Search settings/)).toBeVisible();await expect(page.getByText("Gestures",{exact:true})).toBeVisible();
  await context.close();
});
