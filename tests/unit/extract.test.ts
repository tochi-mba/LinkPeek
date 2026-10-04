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
  it("deduplicates canonical URLs and stable Discourse upload IDs",()=>{
    const item=extractMediaFromHtml(html,"https://forum.example/t/topic/1")[0];
    const d=dedupeMedia([item,{...item,originalUrl:"https://mirror.example/different.jpeg",score:.2}]);
    expect(d.items).toHaveLength(1);expect(d.duplicates).toBe(1);
  });
});
