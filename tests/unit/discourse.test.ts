import {afterEach,describe,expect,it,vi} from "vitest";
import {parsePreloadedDiscourseTopic,prefetchDiscourse,scanDiscourse} from "../../src/core/discourse";
import {DEFAULT_SETTINGS} from "../../src/shared/settings";

const makePost=(id:number)=>({id,post_number:id,username:"u",cooked:`<img src="https://files.example/${id}.jpg" width="800" height="600">`});

describe("Discourse topic scanning",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("parses modern data-preloaded topic payloads",()=>{
    const topic={id:700,title:"Fixture",post_stream:{stream:[11],posts:[{id:11,post_number:29,username:"user",cooked:"<p>hello</p>",post_url:"/t/fixture/700/29"}]}};
    const preload=JSON.stringify({topic_700:JSON.stringify(topic)});
    const html=`<!doctype html><meta name="generator" content="Discourse 2026"><script type="application/json" id="data-preloaded">${preload}</script>`;
    expect(parsePreloadedDiscourseTopic(html,700)).toEqual(topic);
  });
  it("returns null for pages without a matching preloaded topic",()=>expect(parsePreloadedDiscourseTopic("<html></html>",700)).toBeNull());

  it("fetches missing post batches concurrently and emits progressive results",async()=>{
    const stream=Array.from({length:100},(_,i)=>i+1),initial=stream.slice(0,20).map(makePost);
    let active=0,maxActive=0,batchCalls=0;
    vi.stubGlobal("fetch",async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);
      if(url.endsWith("/t/topic/700.json"))return new Response(JSON.stringify({id:700,title:"Perf",post_stream:{stream,posts:initial}}),{status:200});
      if(url.includes("/t/700/posts.json")){
        batchCalls++;active++;maxActive=Math.max(maxActive,active);
        await new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(resolve,150);init?.signal?.addEventListener("abort",()=>{clearTimeout(timer);reject(new DOMException("Aborted","AbortError"))},{once:true});
        });active--;
        const ids=new URL(url).searchParams.getAll("post_ids[]").map(Number);
        return new Response(JSON.stringify({post_stream:{posts:ids.map(makePost)}}),{status:200});
      }
      return new Response("missing",{status:404});
    });
    const progress:number[]=[];
    const result=await scanDiscourse("https://forum.example/t/topic/700",40,100,{...DEFAULT_SETTINGS,maxRequests:3,minWidth:0,minHeight:0},undefined,{onProgress:r=>progress.push(r.postsScanned??0)});
    expect(batchCalls).toBe(2);expect(maxActive).toBe(2);expect(progress[0]).toBe(20);
    expect(result.postsScanned).toBe(100);expect(result.items).toHaveLength(100);expect(result.complete).toBe(true);
  });

  it("aborts outstanding post batches",async()=>{
    const stream=Array.from({length:220},(_,i)=>i+1),initial=stream.slice(0,20).map(makePost),controller=new AbortController();
    let started=0,aborted=0;
    vi.stubGlobal("fetch",async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);
      if(url.endsWith("/t/topic/701.json"))return new Response(JSON.stringify({id:701,title:"Abort",post_stream:{stream,posts:initial}}),{status:200});
      if(url.includes("/t/701/posts.json")){
        started++;
        return await new Promise<Response>((resolve,reject)=>{
          const timer=setTimeout(()=>resolve(new Response(JSON.stringify({post_stream:{posts:[]}}),{status:200})),1000);
          init?.signal?.addEventListener("abort",()=>{aborted++;clearTimeout(timer);reject(new DOMException("Aborted","AbortError"))},{once:true});
        });
      }
      return new Response("missing",{status:404});
    });
    const promise=scanDiscourse("https://forum.example/t/topic/701",40,220,{...DEFAULT_SETTINGS,maxRequests:3},undefined,{signal:controller.signal});
    await new Promise(r=>setTimeout(r,20));controller.abort();
    await expect(promise).rejects.toMatchObject({name:"AbortError"});
    expect(started).toBeGreaterThan(0);expect(started).toBeLessThanOrEqual(3);expect(aborted).toBe(started);
  });

  it("stops scanning once the configured media cap is exceeded",async()=>{
    const stream=[1,2,3],initial=[makePost(1)];let batches=0;
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{const url=String(input);if(url.endsWith("/t/capped/702.json"))return new Response(JSON.stringify({id:702,title:"Capped",post_stream:{stream,posts:initial}}));batches++;const ids=new URL(url).searchParams.getAll("post_ids[]").map(Number);return new Response(JSON.stringify({post_stream:{posts:ids.map(makePost)}}))}));
    const result=await scanDiscourse("https://forum.example/t/capped/702",1,3,{...DEFAULT_SETTINGS,maxRequests:1,maxMediaItems:1,minWidth:0,minHeight:0});
    expect(result.items).toHaveLength(1);expect(result.complete).toBe(true);expect(result.diagnostics?.warnings.join(" ")).toContain("media limit");expect(batches).toBe(1);
  });
});


describe("Discourse fallback and scope coverage",()=>{
  afterEach(()=>vi.unstubAllGlobals());

  it("parses object preloads and rejects malformed/missing preload values",()=>{
    const objectTopic={id:5,post_stream:{posts:[],stream:[]}};
    expect(parsePreloadedDiscourseTopic(`<script id="data-preloaded" type="application/json">${JSON.stringify({topic_5:objectTopic})}</script>`,5)).toEqual(objectTopic);
    expect(parsePreloadedDiscourseTopic('<script id="data-preloaded" type="application/json">{bad</script>',5)).toBeNull();
    expect(parsePreloadedDiscourseTopic('<script id="data-preloaded" type="application/json">{"other":"x"}</script>',5)).toBeNull();
  });

  it("rejects URLs that are not valid Discourse topic URLs",async()=>{
    await expect(prefetchDiscourse("https://forum.example/latest")).rejects.toThrow("Not a Discourse topic URL");
    await expect(prefetchDiscourse("https://forum.example/t/topic/no-id")).rejects.toThrow("Not a Discourse topic URL");
    await expect(scanDiscourse("https://forum.example/latest")).rejects.toThrow("Not a Discourse topic URL");
  });

  it("falls back from topic JSON to embedded preloaded HTML and reports a warning",async()=>{
    const topic={id:77,title:"Fallback",post_stream:{stream:[1],posts:[{id:1,post_number:1,username:"u",cooked:'<img src="https://files.example/a.jpg" width="500" height="400">'}]}};
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.endsWith(".json"))return new Response("no",{status:404});
      return new Response(`<script id="data-preloaded" type="application/json">${JSON.stringify({topic_77:JSON.stringify(topic)})}</script>`,{status:200});
    }));
    const {result,seed}=await prefetchDiscourse("https://forum.example/t/fallback/77",{...DEFAULT_SETTINGS,minWidth:0,minHeight:0});
    expect(seed.warning).toContain("embedded");
    expect(result.items).toHaveLength(1);
    expect(result.diagnostics?.warnings).toHaveLength(1);
  });

  it("rethrows primary topic errors when embedded fallback is unavailable or request is aborted",async()=>{
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);return url.endsWith(".json")?new Response("no",{status:500}):new Response("<html></html>",{status:200});
    }));
    await expect(prefetchDiscourse("https://forum.example/t/no-fallback/78")).rejects.toThrow("HTTP 500");

    const controller=new AbortController();controller.abort();
    await expect(prefetchDiscourse("https://forum.example/t/aborted/79",DEFAULT_SETTINGS,controller.signal)).rejects.toMatchObject({name:"AbortError"});
  });

  it("covers prefetch first/page/default scopes and empty post streams",async()=>{
    const topic={id:80,title:"Scope",post_stream:{stream:Array.from({length:100},(_,i)=>i+1),posts:[{id:1,post_number:1,cooked:""},{id:2,post_number:2}]}};
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify(topic),{status:200}));vi.stubGlobal("fetch",fetchMock);
    let x=await prefetchDiscourse("https://forum.example/t/scope/80",{...DEFAULT_SETTINGS,scanScope:"first",maxPosts:90});
    expect(x.result.totalPosts).toBe(50);
    x=await prefetchDiscourse("https://forum.example/t/scope/80",{...DEFAULT_SETTINGS,scanScope:"page"});
    expect(x.result.totalPosts).toBe(2);
    x=await prefetchDiscourse("https://forum.example/t/scope/80");
    expect(x.result.totalPosts).toBe(100);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({id:81,title:"Empty"}),{status:200}));
    const empty=await prefetchDiscourse("https://forum.example/t/empty/81");
    expect(empty.result.items).toEqual([]);expect(empty.result.totalPosts).toBe(0);
  });

  it("uses exact post URLs when available and fallback post URLs otherwise",async()=>{
    const topic={id:82,title:"URLs",post_stream:{stream:[1,2],posts:[
      {id:1,post_number:3,username:"a",post_url:"/t/urls/82/3",cooked:'<img src="/a.jpg" width="500" height="400">'},
      {id:2,post_number:4,username:"b",cooked:'<img src="/b.jpg" width="500" height="400">'}
    ]}};
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(topic),{status:200})));
    const r=await scanDiscourse("https://forum.example/t/urls/82",50,10,{...DEFAULT_SETTINGS,minWidth:0,minHeight:0});
    expect(r.items.map(i=>i.sourceUrl)).toEqual(["https://forum.example/t/urls/82/3","https://forum.example/t/urls/82/4"]);
  });

  it("recovers failed batch endpoints with individual post JSON and skips individual failures",async()=>{
    const stream=[1,2,3],initial=[makePost(1)];
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.endsWith("/t/recover/83.json"))return new Response(JSON.stringify({id:83,title:"Recover",post_stream:{stream,posts:initial}}),{status:200});
      if(url.includes("/t/83/posts.json"))return new Response("batch down",{status:503});
      if(url.endsWith("/posts/2.json"))return new Response(JSON.stringify(makePost(2)),{status:200});
      if(url.endsWith("/posts/3.json"))return new Response("gone",{status:404});
      return new Response("missing",{status:404});
    }));
    const r=await scanDiscourse("https://forum.example/t/recover/83",50,10,{...DEFAULT_SETTINGS,minWidth:0,minHeight:0});
    expect(r.postsScanned).toBe(2);expect(r.items).toHaveLength(2);expect(r.complete).toBe(false);
  });

  it("rethrows aborts during individual-post batch recovery",async()=>{
    const controller=new AbortController(),stream=[1,2],initial=[makePost(1)];
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.endsWith("/t/abort-recover/84.json"))return new Response(JSON.stringify({id:84,post_stream:{stream,posts:initial}}),{status:200});
      if(url.includes("/t/84/posts.json"))return new Response("down",{status:500});
      if(url.endsWith("/posts/2.json")){controller.abort();throw new DOMException("Aborted","AbortError")}
      return new Response("missing",{status:404});
    }));
    await expect(scanDiscourse("https://forum.example/t/abort-recover/84",50,10,DEFAULT_SETTINGS,undefined,{signal:controller.signal})).rejects.toMatchObject({name:"AbortError"});
  });

  it("handles successful batch responses with no posts and custom batch size/concurrency branches",async()=>{
    const stream=[1,2,3,4],initial=[makePost(1)],calls:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);calls.push(url);
      if(url.endsWith("/t/no-posts/85.json"))return new Response(JSON.stringify({id:85,post_stream:{stream,posts:initial}}),{status:200});
      if(url.includes("/t/85/posts.json"))return new Response(JSON.stringify({post_stream:{}}),{status:200});
      return new Response("missing",{status:404});
    }));
    const progress:number[]=[];
    const r=await scanDiscourse("https://forum.example/t/no-posts/85",0,10,{...DEFAULT_SETTINGS,maxRequests:99},undefined,{onProgress:x=>progress.push(x.postsScanned??0)});
    expect(r.postsScanned).toBe(1);expect(r.complete).toBe(false);expect(progress[0]).toBe(1);expect(calls.some(x=>x.includes("post_ids"))).toBe(true);
  });

  it("covers zero-id fallback and missing post-stream/default concurrency branches",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response("no",{status:500})));
    await expect(prefetchDiscourse("https://forum.example/t/zero/0")).rejects.toThrow("HTTP 500");

    const emptySeed={topic:{id:87,title:"No stream"}};
    const empty=await scanDiscourse("https://forum.example/t/no-stream/87",50,10,undefined,emptySeed);
    expect(empty.items).toEqual([]);expect(empty.totalPosts).toBe(0);expect(empty.complete).toBe(true);

    const seeded={topic:{id:88,title:"Default concurrency",post_stream:{stream:[1],posts:[]}}};
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.includes("/t/88/posts.json"))return new Response(JSON.stringify({post_stream:{posts:[makePost(1)]}}),{status:200});
      return new Response("missing",{status:404});
    }));
    const one=await scanDiscourse("https://forum.example/t/defaults/88",50,10,undefined,seeded);
    expect(one.postsScanned).toBe(1);expect(one.complete).toBe(true);
  });

  it("uses supplied seeds, page/first scan scopes, clamps large batches and runs without progress callbacks",async()=>{
    const posts=Array.from({length:3},(_,i)=>makePost(i+1)),seed={topic:{id:86,title:"Seed",post_stream:{stream:[1,2,3,4],posts}}};
    const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
      const u=new URL(String(input));const ids=u.searchParams.getAll("post_ids[]").map(Number);
      return new Response(JSON.stringify({post_stream:{posts:ids.map(makePost)}}),{status:200});
    });vi.stubGlobal("fetch",fetchMock);
    let r=await scanDiscourse("https://forum.example/t/seed/86",500,10,{...DEFAULT_SETTINGS,scanScope:"page",maxRequests:1},seed);
    expect(r.totalPosts).toBe(3);expect(fetchMock).not.toHaveBeenCalled();
    r=await scanDiscourse("https://forum.example/t/seed/86",-5,2,{...DEFAULT_SETTINGS,scanScope:"first",maxRequests:1,minWidth:0,minHeight:0},seed);
    expect(r.totalPosts).toBe(2);expect(r.complete).toBe(true);
  });
  it("uses default concurrency and tolerates missing post-stream fields",async()=>{
    const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
      const u=new URL(String(input)),ids=u.searchParams.getAll("post_ids[]").map(Number);
      return new Response(JSON.stringify({post_stream:{posts:ids.map(makePost)}}),{status:200});
    });vi.stubGlobal("fetch",fetchMock);
    const missingPosts={topic:{id:90,title:"Missing posts",post_stream:{stream:[1]}}};
    const a=await scanDiscourse("https://forum.example/t/missing-posts/90",50,10,undefined,missingPosts);
    expect(a.postsScanned).toBe(1);expect(a.complete).toBe(true);
    const missingStream={topic:{id:91,title:"Missing stream",post_stream:{posts:[makePost(1)]}}};
    const b=await scanDiscourse("https://forum.example/t/missing-stream/91",50,10,undefined,missingStream);
    expect(b.totalPosts).toBe(0);expect(b.items).toHaveLength(1);
    const noStream={topic:{id:92,title:"No stream"}};
    const d=await scanDiscourse("https://forum.example/t/no-stream/92",50,10,undefined,noStream);
    expect(d.totalPosts).toBe(0);expect(d.items).toEqual([]);
  });

  it("composes progressive results while another batch slot is still pending",async()=>{
    const seed={topic:{id:93,title:"Partial",post_stream:{stream:[1,2,3],posts:[makePost(1)]}}};
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
      const u=new URL(String(input)),ids=u.searchParams.getAll("post_ids[]").map(Number),id=ids[0];
      await new Promise(r=>setTimeout(r,id===2?140:300));
      return new Response(JSON.stringify({post_stream:{posts:ids.map(makePost)}}),{status:200});
    }));
    const progress:number[]=[];
    const r=await scanDiscourse("https://forum.example/t/partial/93",1,10,{...DEFAULT_SETTINGS,maxRequests:2,minWidth:0,minHeight:0},seed,{onProgress:x=>progress.push(x.postsScanned??0)});
    expect(progress).toContain(2);expect(r.postsScanned).toBe(3);expect(r.items).toHaveLength(3);
  });

});
