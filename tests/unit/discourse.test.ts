import {afterEach,describe,expect,it,vi} from "vitest";
import {parsePreloadedDiscourseTopic,scanDiscourse} from "../../src/core/discourse";
import {DEFAULT_SETTINGS} from "../../src/shared/settings";

describe("Discourse embedded topic data",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("parses modern data-preloaded topic payloads",()=>{
    const topic={id:700,title:"Fixture",post_stream:{stream:[11],posts:[{id:11,post_number:29,username:"user",cooked:"<p>hello</p>",post_url:"/t/fixture/700/29"}]}};
    const preload=JSON.stringify({topic_700:JSON.stringify(topic)});
    const html=`<!doctype html><meta name="generator" content="Discourse 2026"><script type="application/json" id="data-preloaded">${preload}</script>`;
    expect(parsePreloadedDiscourseTopic(html,700)).toEqual(topic);
  });
  it("returns null for pages without a matching preloaded topic",()=>{
    expect(parsePreloadedDiscourseTopic("<html></html>",700)).toBeNull();
  });
  it("fetches missing post batches concurrently and emits an initial progressive result",async()=>{
    const stream=Array.from({length:100},(_,i)=>i+1),makePost=(id:number)=>({id,post_number:id,username:"u",cooked:`<img src="https://files.example/${id}.jpg" width="800" height="600">`});
    const initial=stream.slice(0,20).map(makePost);let active=0,maxActive=0,batchCalls=0;
    vi.stubGlobal("fetch",async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);
      if(url.endsWith("/t/topic/700.json"))return new Response(JSON.stringify({id:700,title:"Perf",post_stream:{stream,posts:initial}}),{status:200});
      if(url.includes("/t/700/posts.json")){
        batchCalls++;active++;maxActive=Math.max(maxActive,active);await new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(resolve,25);init?.signal?.addEventListener("abort",()=>{clearTimeout(timer);reject(new DOMException("Aborted","AbortError"))},{once:true});
        });active--;
        const ids=new URL(url).searchParams.getAll("post_ids[]").map(Number);
        return new Response(JSON.stringify({post_stream:{posts:ids.map(makePost)}}),{status:200});
      }
      return new Response("missing",{status:404});
    });
    const progress:number[]=[];
    const result=await scanDiscourse("https://forum.example/t/topic/700",40,100,{...DEFAULT_SETTINGS,maxRequests:3,minWidth:0,minHeight:0},{onProgress:r=>progress.push(r.postsScanned??0)});
    expect(batchCalls).toBe(2);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(progress[0]).toBe(20);
    expect(result.postsScanned).toBe(100);
    expect(result.complete).toBe(true);
    expect(result.items).toHaveLength(100);
  });
});
