import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../../src/shared/settings";
import type {ScanResult} from "../../src/shared/media";

const mocks=vi.hoisted(()=>({
  scanDiscourse:vi.fn(),prefetchDiscourse:vi.fn(),scanGeneric:vi.fn()
}));
vi.mock("../../src/core/discourse",()=>({
  scanDiscourse:mocks.scanDiscourse,prefetchDiscourse:mocks.prefetchDiscourse
}));
vi.mock("../../src/core/generic",()=>({scanGeneric:mocks.scanGeneric}));

const direct=(url:string,kind:any="generic"):ScanResult=>({url,kind,title:"x",items:[],complete:true,diagnostics:{adapter:"x",ignored:0,duplicates:0,warnings:[]}});

describe("background service worker",()=>{
  let installed:(d:any)=>any,message:(msg:any,sender:any,send:(x:any)=>void)=>any;
  let store:Record<string,any>,sent:any[],created:any[],download:any,openOptions:any;
  const tick=()=>new Promise<void>(r=>queueMicrotask(r));

  beforeEach(async()=>{
    vi.resetModules();mocks.scanDiscourse.mockReset();mocks.prefetchDiscourse.mockReset();mocks.scanGeneric.mockReset();
    store={settings:{...DEFAULT_SETTINGS,hoverDelay:0,cacheThreads:true,progressiveScan:true}};sent=[];created=[];
    download=vi.fn(async()=>7);openOptions=vi.fn();
    vi.stubGlobal("chrome",{
      storage:{local:{
        get:vi.fn(async(k:string)=>({[k]:store[k]})),
        set:vi.fn(async(v:any)=>Object.assign(store,v))
      }},
      runtime:{
        onInstalled:{addListener:vi.fn((cb:any)=>installed=cb)},
        onMessage:{addListener:vi.fn((cb:any)=>message=cb)},
        getURL:vi.fn((p:string)=>`chrome-extension://id/${p}`),
        openOptionsPage:openOptions
      },
      tabs:{
        create:vi.fn(async(v:any)=>{created.push(v);return {id:1}}),
        sendMessage:vi.fn(async(...args:any[])=>{sent.push(args);return {ok:true}})
      },
      downloads:{download}
    });
    mocks.scanGeneric.mockImplementation(async(url:string)=>direct(url));
    mocks.prefetchDiscourse.mockImplementation(async(url:string)=>({result:{...direct(url,"discourse"),complete:false},seed:{topic:{id:1,post_stream:{posts:[],stream:[]}}}}));
    mocks.scanDiscourse.mockImplementation(async(url:string,_b:number,_m:number,_s:any,_seed:any,hooks:any)=>{
      hooks?.onProgress?.({...direct(url,"discourse"),complete:false,postsScanned:1,totalPosts:2});
      return {...direct(url,"discourse"),complete:true,postsScanned:2,totalPosts:2};
    });
    await import("../../src/background");
  });
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()});

  function send(msg:any,sender:any={tab:{id:3},frameId:2}){
    return new Promise<{ret:any,value:any}>(resolve=>{
      let settled=false,ret:any;
      const respond=(value:any)=>{settled=true;resolve({ret,value})};
      ret=message(msg,sender,respond);
      if(ret!==true&&!settled)resolve({ret,value:undefined});
    });
  }

  it("handles install and non-install lifecycle",async()=>{
    await installed({reason:"install"});expect(store.settings).toEqual(DEFAULT_SETTINGS);expect(created[0].url).toContain("onboarding.html");
    const before=created.length;await installed({reason:"update"});expect(created).toHaveLength(before);
  });

  it("handles shallow prefetch variants, cached reuse and prefetch errors",async()=>{
    let r=await send({type:"LINKPEEK_PREFETCH",url:"https://x.test/a.jpg",kind:"direct-image"});expect(r.value.kind).toBe("direct-image");
    await send({type:"LINKPEEK_PREFETCH",url:"https://x.test/a.jpg",kind:"direct-image"});
    r=await send({type:"LINKPEEK_PREFETCH",url:"https://x.test/page",kind:"generic"});expect(r.value).toBeNull();
    r=await send({type:"LINKPEEK_PREFETCH",url:"https://x.test/t/a/1",kind:"discourse"});expect(r.value.kind).toBe("discourse");
    await send({type:"LINKPEEK_PREFETCH",url:"https://x.test/t/a/1",kind:"discourse"});expect(mocks.prefetchDiscourse).toHaveBeenCalledTimes(1);
    mocks.prefetchDiscourse.mockRejectedValueOnce(new Error("prefetch failed"));
    r=await send({type:"LINKPEEK_PREFETCH",url:"https://x.test/t/b/2",kind:"discourse"});expect(r.value.error).toBe("prefetch failed");
  });

  it("scans direct/generic/discourse, broadcasts progress and reuses completed cache",async()=>{
    let r=await send({type:"LINKPEEK_SCAN",url:"https://x.test/a.jpg",kind:"direct-image",token:"a"});expect(r.value.items[0].type).toBe("image");
    r=await send({type:"LINKPEEK_SCAN",url:"https://x.test/a.gif",kind:"direct-image",token:"g"});expect(r.value.items[0].type).toBe("gif");
    r=await send({type:"LINKPEEK_SCAN",url:"https://x.test/page",kind:"generic",token:"p"});expect(r.value.kind).toBe("generic");
    await send({type:"LINKPEEK_SCAN",url:"https://x.test/page",kind:"generic",token:"p2"});expect(mocks.scanGeneric).toHaveBeenCalledTimes(1);

    mocks.scanDiscourse.mockImplementationOnce(async(url:string,_b:number,_m:number,_s:any,_seed:any,hooks:any)=>{
      hooks?.onProgress?.({...direct(url,"discourse"),complete:false,postsScanned:1,totalPosts:2});
      await new Promise(r=>setTimeout(r,70));
      return {...direct(url,"discourse"),complete:true,postsScanned:2,totalPosts:2};
    });
    r=await send({type:"LINKPEEK_SCAN",url:"https://x.test/t/a/7",kind:"discourse",token:"d"});
    expect(r.value.complete).toBe(true);expect(sent.length).toBeGreaterThan(0);
    sent=[];await send({type:"LINKPEEK_SCAN",url:"https://x.test/t/no-tab/8",kind:"discourse"},{});await new Promise(r=>setTimeout(r,70));expect(sent).toHaveLength(0);
  });

  it("deduplicates in-flight scans and cancels when the last consumer leaves",async()=>{
    let resolve!: (v:ScanResult)=>void;
    mocks.scanGeneric.mockImplementationOnce((url:string)=>new Promise<ScanResult>(r=>{resolve=r}));
    const p1=send({type:"LINKPEEK_SCAN",url:"https://x.test/slow",kind:"generic",token:"one"});
    const p2=send({type:"LINKPEEK_SCAN",url:"https://x.test/slow",kind:"generic"});
    await tick();expect(mocks.scanGeneric).toHaveBeenCalledTimes(1);
    resolve(direct("https://x.test/slow"));expect((await p1).value.complete).toBe(true);expect((await p2).value.complete).toBe(true);

    mocks.scanGeneric.mockImplementationOnce(async(_url:string,_settings:any,signal:AbortSignal)=>await new Promise<ScanResult>((_r,reject)=>{
      signal.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true});
    }));
    const slow=send({type:"LINKPEEK_SCAN",url:"https://x.test/abort",kind:"generic",token:"kill"});
    await tick();const cancelled=await send({type:"LINKPEEK_CANCEL_SCAN",url:"https://x.test/abort",token:"kill"});expect(cancelled.value.ok).toBe(true);
    expect((await slow).value.cancelled).toBe(true);
    await send({type:"LINKPEEK_CANCEL_SCAN",url:"https://x.test/missing",token:"x"});
  });

  it("handles cache expiration, byte fallback, oversize entries and LRU eviction",async()=>{
    let now=1_000;vi.spyOn(Date,"now").mockImplementation(()=>now);
    await send({type:"LINKPEEK_SCAN",url:"https://x.test/expire",kind:"generic",token:"a"});expect(mocks.scanGeneric).toHaveBeenCalledTimes(1);
    now+=DEFAULT_SETTINGS.cacheMinutes*60_000+1;
    await send({type:"LINKPEEK_SCAN",url:"https://x.test/expire",kind:"generic",token:"b"});expect(mocks.scanGeneric).toHaveBeenCalledTimes(2);

    store.settings={...store.settings,maxCacheMb:1};
    mocks.scanGeneric.mockImplementationOnce(async(url:string)=>{
      const x:any=direct(url);x.self=x;return x;
    });
    await send({type:"LINKPEEK_SCAN",url:"https://x.test/circular",kind:"generic",token:"c"});

    mocks.scanGeneric.mockImplementation(async(url:string)=>({...direct(url),title:"x".repeat(700_000)}));
    await send({type:"LINKPEEK_SCAN",url:"https://x.test/lru1",kind:"generic",token:"1"});
    await send({type:"LINKPEEK_SCAN",url:"https://x.test/lru2",kind:"generic",token:"2"});
    const before=mocks.scanGeneric.mock.calls.length;await send({type:"LINKPEEK_SCAN",url:"https://x.test/lru1",kind:"generic",token:"3"});
    expect(mocks.scanGeneric.mock.calls.length).toBeGreaterThan(before);
    mocks.scanGeneric.mockImplementationOnce(async(url:string)=>({...direct(url),title:"x".repeat(1_200_000)}));
    await send({type:"LINKPEEK_SCAN",url:"https://x.test/too-big",kind:"generic",token:"4"});
  });

  it("handles binary fetch/cache/prefetch and binary error cases",async()=>{
    const response=(body:ArrayBuffer,status=200,headers:Record<string,string>={})=>{
      const r=new Response(body,{status,headers});return r;
    };
    const fetchMock=vi.fn();
    vi.stubGlobal("fetch",fetchMock);
    fetchMock.mockResolvedValueOnce(response(new Uint8Array([1,2,3]).buffer,200,{"content-type":"image/gif"}));
    let r=await send({type:"LINKPEEK_FETCH_BINARY",url:"https://x.test/a.gif",maxMb:1});expect(r.value.bytes).toBe(3);
    const calls=fetchMock.mock.calls.length;r=await send({type:"LINKPEEK_PREFETCH_BINARY",url:"https://x.test/a.gif",maxMb:1});expect(r.value.ok).toBe(true);expect(fetchMock).toHaveBeenCalledTimes(calls);

    r=await send({type:"LINKPEEK_FETCH_BINARY",url:"file:///x.gif",maxMb:1});expect(r.value.error).toContain("Unsupported");
    fetchMock.mockResolvedValueOnce(response(new ArrayBuffer(0),500));r=await send({type:"LINKPEEK_FETCH_BINARY",url:"https://x.test/http.gif",maxMb:1});expect(r.value.error).toContain("HTTP 500");
    fetchMock.mockResolvedValueOnce(response(new ArrayBuffer(0),200,{"content-length":"2000000"}));r=await send({type:"LINKPEEK_FETCH_BINARY",url:"https://x.test/announced.gif",maxMb:1});expect(r.value.error).toContain("larger");
    fetchMock.mockResolvedValueOnce(response(new ArrayBuffer(1_100_000),200));r=await send({type:"LINKPEEK_FETCH_BINARY",url:"https://x.test/body.gif",maxMb:1});expect(r.value.error).toContain("larger");
  });

  it("covers pending prefetch/scan races, repeated progress and default sender branches",async()=>{
    let resolvePrefetch!:(v:any)=>void;
    mocks.prefetchDiscourse.mockImplementationOnce(()=>new Promise(r=>{resolvePrefetch=r}));
    const p1=send({type:"LINKPEEK_PREFETCH",url:"https://x.test/t/pending/20",kind:"discourse"});
    const p2=send({type:"LINKPEEK_PREFETCH",url:"https://x.test/t/pending/20",kind:"discourse"});
    await tick();expect(mocks.prefetchDiscourse).toHaveBeenCalledTimes(1);
    resolvePrefetch({result:{...direct("https://x.test/t/pending/20","discourse"),complete:false},seed:{topic:{id:20,post_stream:{posts:[],stream:[]}}}});
    expect((await p1).value.kind).toBe("discourse");expect((await p2).value.kind).toBe("discourse");

    let releaseWarm!:(v:any)=>void;
    mocks.prefetchDiscourse.mockImplementationOnce(()=>new Promise(r=>{releaseWarm=r}));
    const warm=send({type:"LINKPEEK_PREFETCH",url:"https://x.test/t/warm/21",kind:"discourse"});
    const scanPromise=send({type:"LINKPEEK_SCAN",url:"https://x.test/t/warm/21",kind:"discourse",token:"warm"},{tab:{id:9}});
    await tick();releaseWarm({result:{...direct("https://x.test/t/warm/21","discourse"),complete:false},seed:{topic:{id:21,post_stream:{posts:[],stream:[]}}}});
    await warm;await scanPromise;

    sent=[];
    mocks.scanDiscourse.mockImplementationOnce(async(url:string,_b:number,_m:number,_s:any,_seed:any,hooks:any)=>{
      hooks?.onProgress?.({...direct(url,"discourse"),complete:false,postsScanned:1,totalPosts:3});
      hooks?.onProgress?.({...direct(url,"discourse"),complete:false,postsScanned:2,totalPosts:3});
      await new Promise(r=>setTimeout(r,70));
      hooks?.onProgress?.({...direct(url,"discourse"),complete:false,postsScanned:3,totalPosts:3});
      return {...direct(url,"discourse"),complete:true,postsScanned:3,totalPosts:3};
    });
    await send({type:"LINKPEEK_SCAN",url:"https://x.test/t/progress/22",kind:"discourse",token:"p"},{tab:{id:7}});
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[0][2]).toEqual({frameId:0});
  });

  it("replaces an aborted task before its old promise settles and tolerates failed warm prefetch",async()=>{
    let rejectOld!:(e:any)=>void;
    mocks.scanGeneric.mockImplementationOnce(async(_u:string,_s:any,signal:AbortSignal)=>await new Promise<ScanResult>((_resolve,reject)=>{
      rejectOld=reject;signal.addEventListener("abort",()=>{}, {once:true});
    }));
    const old=send({type:"LINKPEEK_SCAN",url:"https://x.test/race",kind:"generic",token:"old"});
    await tick();await send({type:"LINKPEEK_CANCEL_SCAN",url:"https://x.test/race",token:"old"});
    mocks.scanGeneric.mockImplementationOnce(async(url:string)=>direct(url));
    const fresh=send({type:"LINKPEEK_SCAN",url:"https://x.test/race",kind:"generic",token:"new"});
    rejectOld(new DOMException("Aborted","AbortError"));
    expect((await old).value.cancelled).toBe(true);expect((await fresh).value.complete).toBe(true);

    let rejectWarm!:(e:any)=>void;
    mocks.prefetchDiscourse.mockImplementationOnce(()=>new Promise((_r,reject)=>{rejectWarm=reject}));
    const warm=send({type:"LINKPEEK_PREFETCH",url:"https://x.test/t/warm-fail/23",kind:"discourse"});
    const scan=send({type:"LINKPEEK_SCAN",url:"https://x.test/t/warm-fail/23",kind:"discourse",token:"s"});
    await tick();rejectWarm(new Error("warm failed"));
    expect((await warm).value.error).toBe("warm failed");expect((await scan).value.complete).toBe(true);
  });

  it("shares pending binary work, uses default limits/mime and evicts binary LRU entries",async()=>{
    const fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);
    let resolve!:(r:Response)=>void;
    fetchMock.mockImplementationOnce(()=>new Promise<Response>(r=>{resolve=r}));
    const a=send({type:"LINKPEEK_FETCH_BINARY",url:"https://x.test/pending.gif"});
    const b=send({type:"LINKPEEK_FETCH_BINARY",url:"https://x.test/pending.gif",maxMb:0});
    await tick();expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(new Response(new Uint8Array([1]).buffer,{status:200}));
    expect((await a).value.mime).toBe("application/octet-stream");expect((await b).value.bytes).toBe(1);

    const fakeBig={byteLength:34*1024*1024,length:1,0:1};
    const bigResponse=()=>({ok:true,status:200,headers:{get:(k:string)=>k==="content-type"?"image/gif":null},arrayBuffer:async()=>fakeBig} as any);
    fetchMock.mockResolvedValueOnce(bigResponse());
    await send({type:"LINKPEEK_FETCH_BINARY",url:"https://x.test/big1.gif",maxMb:40});
    fetchMock.mockResolvedValueOnce(bigResponse());
    await send({type:"LINKPEEK_FETCH_BINARY",url:"https://x.test/big2.gif",maxMb:40});
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clears caches, opens options, downloads and reports download failure",async()=>{
    let r=await send({type:"LINKPEEK_CLEAR_CACHE"});expect(r.value.ok).toBe(true);
    r=await send({type:"LINKPEEK_OPEN_OPTIONS"});expect(r.value.ok).toBe(true);expect(openOptions).toHaveBeenCalled();
    r=await send({type:"LINKPEEK_DOWNLOAD",url:"https://x.test/a.jpg",filename:"a.jpg"});expect(r.value.id).toBe(7);
    download.mockRejectedValueOnce(new Error("download failed"));r=await send({type:"LINKPEEK_DOWNLOAD",url:"https://x.test/b.jpg"});expect(r.value.error).toBe("download failed");
    expect(message({type:"UNKNOWN"},{},vi.fn())).toBeUndefined();
  });

  it("covers progressive disabled, scan error, and already-aborted task replacement",async()=>{
    store.settings={...store.settings,progressiveScan:false,cacheThreads:false};
    mocks.scanGeneric.mockRejectedValueOnce(new Error("scan fail"));
    let r=await send({type:"LINKPEEK_SCAN",url:"https://x.test/error",kind:"generic",token:"e"});expect(r.value.error).toBe("scan fail");
    r=await send({type:"LINKPEEK_SCAN",url:"https://x.test/t/noprogress/9",kind:"discourse",token:"np"});expect(r.value.complete).toBe(true);
  });
});
