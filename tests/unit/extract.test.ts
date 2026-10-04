import {describe,expect,it} from "vitest";
import {dedupeMedia,extractMediaFromHtml} from "../../src/core/extract";

const html=`
<div class="cooked">
  <div class="lightbox-wrapper"><a class="lightbox" href="https://files.example/original/4X/a/hash.jpeg" title="Photo 1"><img src="https://files.example/optimized/4X/a/hash_2_690x388.jpeg" width="690" height="388"></a></div>
  <img class="avatar" src="/avatar.png" width="48" height="48">
  <img class="emoji" src="/emoji.png" width="20" height="20">
  <img src="https://cdn.example/content.jpg" width="1200" height="800" alt="content">
</div>`;

describe("media extraction",()=>{
  it("prefers lightbox originals and ignores avatar/emoji chrome",()=>{
    const items=extractMediaFromHtml(html,"https://forum.example/t/topic/1");
    expect(items).toHaveLength(2);
    expect(items[0].originalUrl).toContain("/original/");
    expect(items[0].previewUrl).toContain("/optimized/");
    expect(items.map(x=>x.filename)).toContain("Photo 1");
    expect(items.some(x=>x.originalUrl.includes("avatar"))).toBe(false);
  });
  it("deduplicates canonical URLs",()=>{
    const item=extractMediaFromHtml(html,"https://forum.example/t/topic/1")[0];
    const d=dedupeMedia([item,{...item,id:"second",score:.2}]);
    expect(d.items).toHaveLength(1);expect(d.duplicates).toBe(1);
  });
});
