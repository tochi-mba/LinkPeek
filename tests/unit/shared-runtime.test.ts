import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {canonicalMediaUrl,classifyLink,uniqueMediaItems,type MediaItem} from "../../src/shared/media";
import {DEFAULT_SETTINGS,effectiveSettings,loadSettings,saveSettings} from "../../src/shared/settings";
import {favoriteKey,isFavorite,loadFavorites,removeFavorite,toggleFavorite} from "../../src/shared/favorites";
import {scanGeneric} from "../../src/core/generic";
import {extractMediaFromHtml} from "../../src/core/extract";
import {REX,rexCss} from "../../src/shared/theme";
import {overlayCss} from "../../src/ui/styles";

const media=(id:string,url:string,score=.5):MediaItem=>({id,type:"image",originalUrl:url,previewUrl:url,sourceUrl:"https://source.test",score});

describe("shared runtime coverage",()=>{
  const store:Record<string,unknown>={};
  beforeEach(()=>{
    for(const k of Object.keys(store))delete store[k];
    vi.stubGlobal("chrome",{
      storage:{local:{
        get:vi.fn(async(key:string)=>typeof key==="string"?{[key]:store[key]}:{...store}),
        set:vi.fn(async(value:Record<string,unknown>)=>{Object.assign(store,value)})
      }}
    });
  });
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()});

  it("classifies every supported link kind and invalid input",()=>{
    expect(classifyLink("#section")).toBe("anchor");
    expect(classifyLink("https://x.test/a.JPG?x=1")).toBe("direct-image");
    expect(classifyLink("https://x.test/a.mp4")).toBe("direct-video");
    expect(classifyLink("https://x.test/t/123")).toBe("discourse");
    expect(classifyLink("https://x.test/t/topic/123")).toBe("discourse");
    expect(classifyLink("https://x.test/file.pdf")).toBe("download");
    expect(classifyLink("mailto:a@b.test")).toBe("ignored");
    expect(classifyLink("https://x.test/article")).toBe("generic");
    expect(classifyLink("http://[bad")).toBe("ignored");
    const originalLocation=(globalThis as any).location;vi.stubGlobal("location",undefined);
    expect(classifyLink("https://x.test/no-location.jpg")).toBe("direct-image");
    vi.stubGlobal("location",originalLocation);
  });

  it("canonicalizes media URLs and tolerates invalid URLs",()=>{
    expect(canonicalMediaUrl("https://x.test/a.jpg?fbclid=x&gclid=y&keep=1#z")).toBe("https://x.test/a.jpg?keep=1");
    expect(canonicalMediaUrl("https://x.test/optimized/hash_2_690x388.jpeg")).toBe("https://x.test/original/hash.jpeg");
    expect(canonicalMediaUrl("https://x.test/optimized/hash_690x388.png")).toBe("https://x.test/original/hash.png");
    expect(canonicalMediaUrl("not a url")).toBe("not a url");
  });

  it("deduplicates by id, original and preview while keeping the better item",()=>{
    const a=media("same","https://x.test/a.jpg",.2);
    const b={...a,originalUrl:"https://x.test/b.jpg",previewUrl:"https://x.test/b.jpg",score:.9};
    const c=media("c","https://x.test/a.jpg",.1);
    const d={...media("d","https://x.test/d.jpg",.5),previewUrl:"https://x.test/a.jpg"};
    const result=uniqueMediaItems([a,b,c,d]);
    expect(result.duplicates).toBe(3);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].score).toBe(.9);
    expect(uniqueMediaItems([])).toEqual({items:[],duplicates:0});
  });

  it("loads, merges and saves settings and handles exact/wildcard/no site overrides",async()=>{
    store.settings={hoverDelay:42,shortcuts:{favorite:["v"]},siteProfiles:{"exact.test":{enabled:false},"*.wild.test":{hoverDelay:7}}};
    const loaded=await loadSettings();
    expect(loaded.hoverDelay).toBe(42);
    expect(loaded.shortcuts.favorite).toEqual(["v"]);
    expect(loaded.shortcuts.grid).toEqual(DEFAULT_SETTINGS.shortcuts.grid);
    expect(effectiveSettings(loaded,"https://exact.test/x").enabled).toBe(false);
    expect(effectiveSettings(loaded,"https://sub.wild.test/x").hoverDelay).toBe(7);
    expect(effectiveSettings(loaded,"https://none.test/x")).toBe(loaded);
    await saveSettings({...loaded,hoverDelay:99});
    expect((store.settings as any).hoverDelay).toBe(99);
    delete store.settings;
    expect((await loadSettings()).hoverDelay).toBe(DEFAULT_SETTINGS.hoverDelay);
  });

  it("stores favorites offline, normalizes URLs, dedupes bad stored data and toggles/remove entries",async()=>{
    expect(favoriteKey("https://x.test/a?utm_source=z&keep=1#frag")).toBe("https://x.test/a?keep=1");
    expect(await loadFavorites()).toEqual([]);
    store.favorites=[
      null,{url:2},{url:"http://[bad",title:"bad"},
      {url:"https://x.test/a?fbclid=x",title:" A ",addedAt:1,mediaCount:3},
      {url:"https://x.test/a",title:"duplicate",addedAt:5},
      {url:"https://x.test/b",title:"",addedAt:10},
      {url:"https://x.test/e",title:42,addedAt:0,mediaCount:NaN}
    ];
    const loaded=await loadFavorites();
    expect(loaded.map(x=>x.url)).toEqual(["https://x.test/b","https://x.test/a","https://x.test/e"]);
    expect(loaded[0].title).toBe("https://x.test/b");
    expect(loaded[1].mediaCount).toBe(3);expect(loaded[2].title).toBe("https://x.test/e");expect(loaded[2].mediaCount).toBeUndefined();
    expect(await isFavorite("https://x.test/a#z")).toBe(true);
    const removed=await toggleFavorite({url:"https://x.test/a"});
    expect(removed.saved).toBe(false);
    const added=await toggleFavorite({url:"https://x.test/c",title:" C ",mediaCount:9});
    expect(added.saved).toBe(true);expect(added.favorite?.title).toBe("C");
    const fallback=await toggleFavorite({url:"https://x.test/d"});expect(fallback.favorite?.title).toBe("https://x.test/d");
    expect(await isFavorite("https://x.test/missing")).toBe(false);
    await removeFavorite("https://x.test/b");
    expect((await loadFavorites()).map(x=>x.url)).toEqual(["https://x.test/d","https://x.test/c","https://x.test/e"]);
    store.favorites=[{url:"https://x.test/no-meta"}];
    const noMeta=await loadFavorites();expect(noMeta[0].addedAt).toBe(0);expect(noMeta[0].mediaCount).toBeUndefined();expect(noMeta[0].title).toBe("https://x.test/no-meta");

  });

  it("scans direct images, GIFs, HTML pages, untitled pages and HTTP errors",async()=>{
    const responses=[
      new Response("x",{status:200,headers:{"content-type":"image/png"}}),
      new Response("x",{status:200,headers:{"content-type":"image/gif"}}),
      new Response("<title> A   Page </title><img src='/a.jpg' width='400' height='300'>",{status:200,headers:{"content-type":"text/html"}}),
      new Response("<img src='/b.jpg' width='400' height='300'>",{status:200}),
      new Response("no",{status:404})
    ];
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
      const response=responses.shift()!;Object.defineProperty(response,"url",{configurable:true,value:String(input)});return response;
    }));
    const png=await scanGeneric("https://x.test/a.png");expect(png.kind).toBe("direct-image");expect(png.items[0].type).toBe("image");
    const gif=await scanGeneric("https://x.test/a.gif");expect(gif.items[0].type).toBe("gif");
    const html=await scanGeneric("https://x.test/page",{...DEFAULT_SETTINGS,minWidth:0,minHeight:0});expect(html.title).toBe("A Page");expect(html.items).toHaveLength(1);
    const untitled=await scanGeneric("https://x.test/no-title",{...DEFAULT_SETTINGS,minWidth:0,minHeight:0});expect(untitled.title).toBeUndefined();
    await expect(scanGeneric("https://x.test/fail")).rejects.toThrow("HTTP 404");
  });


  it("covers generic responses without a content-type header",async()=>{
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>({
      ok:true,status:200,url:String(input),headers:{get:()=>null},
      text:async()=>'<img src="/plain.jpg" width="400" height="300">'
    } as any)));
    const r=await scanGeneric("https://x.test/plain",{...DEFAULT_SETTINGS,minWidth:0,minHeight:0});
    expect(r.kind).toBe("generic");expect(r.items).toHaveLength(1);
  });

  it("recursively searches bounded same-site links only when the root has no media",async()=>{
    const calls:Array<{url:string;credentials?:RequestCredentials}>=[];
    const response=(url:string,body:string,status=200,type="text/html",finalUrl=url)=>{const r=new Response(body,{status,headers:{"content-type":type}});Object.defineProperty(r,"url",{configurable:true,value:finalUrl});return r};
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);calls.push({url,credentials:init?.credentials});
      if(url==="https://x.test/root")return response(url,`<title>Root</title><a href="/empty?utm_source=x#part">Empty</a><a href="/broken">Broken</a><a href="/redirect">Redirect</a><a href="/photo.jpg">Photo</a><a href="https://other.test/out">External</a><a href="mailto:a@b.test">Mail</a><a href="/logout">Logout</a><a href="/file.pdf">PDF</a><a href="https://u:p@x.test/private">Private</a><a href="http://[">Bad</a><a href="/empty">Duplicate</a><a href="/empty" rel="nofollow">No follow</a><a href="/empty" download>Download</a>`);
      if(url==="https://x.test/empty")return response(url,'<a href="/deep?b=2&amp;a=1">Deep</a>');
      if(url==="https://x.test/broken")return response(url,"no",500);
      if(url==="https://x.test/redirect")return response(url,"<p>moved</p>",200,"text/html","https://other.test/moved");
      if(url==="https://x.test/photo.jpg")return response(url,"x",200,"image/jpeg");
      if(url==="https://x.test/deep?a=1&b=2")return response(url,'<img src="/one.jpg" width="600" height="400"><img src="/two.jpg" width="600" height="400"><img src="/three.jpg" width="600" height="400">');
      throw new Error(`unexpected ${url}`);
    }));
    const settings={...DEFAULT_SETTINGS,minWidth:0,minHeight:0,recursiveSearch:"same-origin" as const,recursiveMaxDepth:2,recursiveMaxPages:10,maxMediaItems:2,stripTracking:true,canonicalizeQuery:true};
    const result=await scanGeneric("https://x.test/root",settings);expect(result.title).toBe("Root");expect(result.items).toHaveLength(2);expect(result.diagnostics?.adapter).toContain("linked-page");expect(result.diagnostics?.warnings.join(" ")).toContain("media limit");expect(result.diagnostics?.warnings.join(" ")).toContain("2 linked pages");
    expect(calls.some(x=>x.url.includes("other.test/out"))).toBe(false);expect(calls.some(x=>x.url.includes("logout"))).toBe(false);expect(calls.find(x=>x.url.includes("deep"))?.credentials).toBe("include");
    expect(result.items.some(x=>x.sourceUrl.includes("deep"))).toBe(true);
  });

  it("supports explicit cross-site recursion and recursion guards",async()=>{
    const calls:Array<{url:string;credentials?:RequestCredentials;redirect?:RequestRedirect;referrerPolicy?:ReferrerPolicy}>=[];
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);calls.push({url,credentials:init?.credentials,redirect:init?.redirect,referrerPolicy:init?.referrerPolicy});const body=url.includes("external")?'<img src="/outside.jpg" width="500" height="400">':'<a href="https://other.test/external">Outside</a>';const r=new Response(body,{headers:{"content-type":"text/html"}});Object.defineProperty(r,"url",{configurable:true,value:url});return r}));
    const external=await scanGeneric("https://x.test/root",{...DEFAULT_SETTINGS,minWidth:0,minHeight:0,recursiveSearch:"all",recursiveMaxPages:2,referrerPolicy:"never",followRedirects:false});expect(external.items).toHaveLength(1);expect(calls[1]).toMatchObject({credentials:"omit",redirect:"manual",referrerPolicy:"no-referrer"});
    const before=calls.length;await scanGeneric("https://x.test/root",{...DEFAULT_SETTINGS,recursiveSearch:"off"});await scanGeneric("https://x.test/root",{...DEFAULT_SETTINGS,recursiveSearch:"all",recursiveMaxPages:1});await scanGeneric("https://x.test/root",DEFAULT_SETTINGS,undefined,false);expect(calls.length-before).toBe(3);
  });

  it("defaults to empty-only recursion and supports an explicit always trigger",async()=>{
    const calls:string[]=[];vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{const url=String(input);calls.push(url);const body=url.endsWith("/root")?'<img src="/cover.jpg" width="500" height="400"><a href="/child">Child</a>':'<img src="/child.jpg" width="500" height="400">';const r=new Response(body,{headers:{"content-type":"text/html"}});Object.defineProperty(r,"url",{value:url});return r}));
    let result=await scanGeneric("https://x.test/root",{...DEFAULT_SETTINGS,minWidth:0,minHeight:0});expect(result.items).toHaveLength(1);expect(calls).toHaveLength(1);
    calls.length=0;result=await scanGeneric("https://x.test/root",{...DEFAULT_SETTINGS,minWidth:0,minHeight:0,recursiveTrigger:"always"});expect(result.items).toHaveLength(2);expect(calls).toHaveLength(2);
  });

  it("reports one linked-page failure and forwards active and pre-aborted cancellation",async()=>{
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);if(init?.signal?.aborted)throw new DOMException("Aborted","AbortError");if(url.endsWith("/root")||url.endsWith("/cancel-root")){const r=new Response(`<a href="/${url.includes("cancel")?"pending":"fail"}">Next</a>`);Object.defineProperty(r,"url",{value:url});return r}if(url.endsWith("/fail"))return new Response("no",{status:500});return await new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true}))}));
    const failed=await scanGeneric("https://x.test/root",{...DEFAULT_SETTINGS,recursiveSearch:"same-origin",recursiveMaxPages:2});expect(failed.diagnostics?.warnings.join(" ")).toContain("1 linked page that");
    const preAborted=new AbortController();preAborted.abort();await expect(scanGeneric("https://x.test/pre-aborted",DEFAULT_SETTINGS,preAborted.signal)).rejects.toMatchObject({name:"AbortError"});
    const active=new AbortController(),pending=scanGeneric("https://x.test/cancel-root",DEFAULT_SETTINGS,active.signal);await Promise.resolve();await Promise.resolve();active.abort();await expect(pending).rejects.toMatchObject({name:"AbortError"});
  });

  it("covers extraction filtering, formats, srcsets, dimensions, quotes and missing attributes",()=>{
    const base="https://forum.test/t/a/1";
    const html=`
      <a class="lightbox"><img src="/missing.jpg"></a>
      <a class="lightbox" href="/tiny.jpg"><img src="/tiny.jpg" width="2" height="2"></a>
      <a class="lightbox" href="/no.svg"><img src="/no.svg" width="500" height="500"></a>
      <img class="avatar" src="/avatar.jpg" width="500" height="500">
      <img class="emoji reaction" src="/emoji.jpg" width="500" height="500">
      <img class="logo" src="/logo.jpg" width="500" height="500">
      <img width="500" height="500">
      <img src="/small.jpg" width="2" height="500">
      <img src="/ok.webp" width="500" height="500" srcset="/a.jpg 1x, /optimized/hash_690x388.webp 2x">
      <img src="/anim.gif?x=1" class="animated" width="500" height="500">
      <img src="/vector.svg" width="500" height="500">
      <img src="/photo.avif" width="500" height="500">
    `;
    const defaults=extractMediaFromHtml(html,base);
    expect(defaults.some(x=>x.originalUrl.includes("ok.webp"))).toBe(true);
    expect(defaults.some(x=>x.type==="gif")).toBe(true);
    expect(defaults.some(x=>x.originalUrl.includes("vector.svg"))).toBe(false);
    const permissive=extractMediaFromHtml(html,base,{},{
      includeImages:true,includeGif:true,includeWebp:true,includeAvif:true,includeSvg:true,
      includeAvatars:true,includeEmoji:true,minWidth:0,minHeight:0,quotedDuplicates:"show"
    });
    expect(permissive.some(x=>x.originalUrl.includes("avatar"))).toBe(true);
    expect(permissive.some(x=>x.originalUrl.includes("emoji"))).toBe(true);
    expect(permissive.some(x=>x.originalUrl.includes("vector.svg"))).toBe(true);
    expect(permissive.some(x=>x.originalUrl.includes("photo.avif"))).toBe(true);
    expect(extractMediaFromHtml('<img src="/x.jpg" width="500" height="500">',base,{},{
      includeImages:false,includeGif:false,includeWebp:false,includeAvif:false,includeSvg:false,
      includeAvatars:false,includeEmoji:false,minWidth:0,minHeight:0,quotedDuplicates:"hide"
    })).toEqual([]);
  });

  it("loads REX theme/style constants",()=>{
    expect(REX.signal).toBe("#D7FF3F");
    expect(rexCss).toContain(REX.signal);
    expect(overlayCss).toContain(".lp-panel");
  });
});
