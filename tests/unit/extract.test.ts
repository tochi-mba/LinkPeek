import {describe,expect,it} from "vitest";
import {dedupeMedia,extractMediaFromHtml} from "../../src/core/extract";

const html=`
<div class="cooked">
  <div class="lightbox-wrapper"><a class="lightbox" href="https://files.example/original/4X/a/hash.jpeg" title="Photo 1"><img src="https://files.example/optimized/4X/a/hash_2_690x388.jpeg" data-base62-sha1="photoHash" width="690" height="388"></a></div>
  <img class="avatar" src="/avatar.png" width="48" height="48">
  <img class="emoji" src="/emoji.png" width="20" height="20">
  <img src="https://cdn.example/content.jpg" width="1200" height="800" alt="content">
</div>`;

describe("media extraction",()=>{
  it("prefers Discourse lightbox originals and ignores avatar/emoji chrome",()=>{
    const items=extractMediaFromHtml(html,"https://forum.example/t/topic/1");
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("upload:photoHash");
    expect(items[0].originalUrl).toContain("/original/");
    expect(items[0].previewUrl).toContain("/optimized/");
    expect(items.map(x=>x.filename)).toContain("Photo 1");
    expect(items.some(x=>x.originalUrl.includes("avatar"))).toBe(false);
  });
  it("recognizes direct animated GIF uploads",()=>{
    const items=extractMediaFromHtml(`<p><img src="https://files.example/original/4X/g/anim.gif" data-base62-sha1="gifHash" width="480" height="372" class="animated" alt="clip"></p>`,"https://forum.example/t/topic/1");
    expect(items).toHaveLength(1);expect(items[0]).toMatchObject({id:"upload:gifHash",type:"gif",filename:"clip"});
  });
  it("hides quoted media by default and can show or mark it",()=>{
    const quote=`<aside class="quote no-group"><blockquote><img src="https://files.example/original/q.gif" data-base62-sha1="quoted" width="400" height="300" class="animated"></blockquote></aside><img src="https://files.example/original/main.gif" data-base62-sha1="main" width="400" height="300" class="animated">`;
    expect(extractMediaFromHtml(quote,"https://forum.example/t/topic/1")).toHaveLength(1);
    expect(extractMediaFromHtml(quote,"https://forum.example/t/topic/1",{}, {quotedDuplicates:"show"})).toHaveLength(2);
    const marked=extractMediaFromHtml(quote,"https://forum.example/t/topic/1",{}, {quotedDuplicates:"mark"});
    expect(marked).toHaveLength(2);expect(marked.find(x=>x.id==="upload:quoted")?.quoted).toBe(true);
  });
  it("covers lightbox and image fallback branches exhaustively",()=>{
    const base="https://forum.example/t/topic/1";
    const source=`
      <a class="lightbox"><img src="/ignored.jpg"></a>
      <a class="lightbox" href="/no-img.jpg"></a>
      <a class="lightbox" href="/vector.svg"><img src="/vector.svg" width="500" height="500"></a>
      <a class="lightbox" href="/tiny-w.jpg"><img src="/tiny-w.jpg" width="20" height="500"></a>
      <a class="lightbox" href="/tiny-h.jpg"><img src="/tiny-h.jpg" width="500" height="20"></a>
      <a class="lightbox" href="/alt.jpg"><img src="/alt-preview.jpg" alt="Alt name"></a>
      <a class="lightbox" href="https://x.test/%E0%A4%A"><img src="https://x.test/%E0%A4%A" width="500" height="500"></a>
      <a class="lightbox" href="/dup.jpg"><img src="/dup.jpg" width="500" height="500"></a>
      <a class="lightbox" href="/dup.jpg"><img src="/dup.jpg" width="500" height="500"></a>
      <img src="/plain.jpg" width="500" height="500" srcset="/regular.jpg 1x">
      <img src="/empty-srcset.jpg" width="500" height="500" srcset=", ">
      <img src="/anim-class.jpg" class="animated" width="500" height="500">
      <a class="lightbox" href="/lightbox.gif"><img src="/lightbox-preview.gif" width="500" height="500"></a>
      <img src="https://x.test/" width="500" height="500">
      <img src="https://x.test/file." width="500" height="500">
      <img src="/tiny-height.jpg" width="500" height="20">
      <img src="/dup.jpg" width="500" height="500">
    `;
    const items=extractMediaFromHtml(source,base,{}, {includeSvg:false,minWidth:120,minHeight:120});
    expect(items.some(x=>x.originalUrl.endsWith("/no-img.jpg"))).toBe(true);
    expect(items.find(x=>x.originalUrl.endsWith("/alt.jpg"))?.filename).toBe("Alt name");
    expect(items.find(x=>x.originalUrl.includes("%E0%A4%A"))?.filename).toBe("media");
    expect(items.filter(x=>x.originalUrl.endsWith("/dup.jpg"))).toHaveLength(1);
    expect(items.find(x=>x.originalUrl.endsWith("/plain.jpg"))?.previewUrl).toBe("https://forum.example/regular.jpg");
    expect(items.find(x=>x.originalUrl.endsWith("/empty-srcset.jpg"))?.previewUrl).toBe("https://forum.example/empty-srcset.jpg");
    expect(items.find(x=>x.originalUrl.endsWith("/anim-class.jpg"))?.type).toBe("gif");
    expect(items.find(x=>x.originalUrl.endsWith("/lightbox.gif"))?.type).toBe("gif");
    expect(items.find(x=>x.originalUrl==="https://x.test/")?.filename).toBe("media");
    expect(items.some(x=>x.originalUrl.includes("file."))).toBe(true);
    expect(items.some(x=>x.originalUrl.includes("vector.svg"))).toBe(false);
    expect(items.some(x=>x.originalUrl.includes("tiny-w")||x.originalUrl.includes("tiny-h"))).toBe(false);

    const invalid=extractMediaFromHtml('<img src="relative.jpg" width="500" height="500">',"not a valid base");
    expect(invalid[0]?.originalUrl).toBe("relative.jpg");
    expect(extractMediaFromHtml("<p>none</p>",base,{}, {quotedDuplicates:"mark"})).toEqual([]);
  });

  it("deduplicates canonical URLs and stable Discourse upload IDs",()=>{
    const item=extractMediaFromHtml(html,"https://forum.example/t/topic/1")[0];
    const d=dedupeMedia([item,{...item,originalUrl:"https://mirror.example/different.jpeg",score:.2}]);
    expect(d.items).toHaveLength(1);expect(d.duplicates).toBe(1);
  });
});
