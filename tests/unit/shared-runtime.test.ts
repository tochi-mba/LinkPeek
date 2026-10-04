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
      {url:"https://x.test/b",title:"",addedAt:10}
    ];
    const loaded=await loadFavorites();
    expect(loaded.map(x=>x.url)).toEqual(["https://x.test/b","https://x.test/a"]);
    expect(loaded[0].title).toBe("https://x.test/b");
    expect(loaded[1].mediaCount).toBe(3);
    expect(await isFavorite("https://x.test/a#z")).toBe(true);
    const removed=await toggleFavorite({url:"https://x.test/a"});
    expect(removed.saved).toBe(false);
    const added=await toggleFavorite({url:"https://x.test/c",title:" C ",mediaCount:9});
    expect(added.saved).toBe(true);expect(added.favorite?.title).toBe("C");
    await removeFavorite("https://x.test/b");
    expect((await loadFavorites()).map(x=>x.url)).toEqual(["https://x.test/c"]);
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
