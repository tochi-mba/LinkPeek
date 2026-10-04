import {describe,expect,it} from "vitest";
import {canonicalMediaUrl,classifyLink} from "../../src/shared/media";

describe("link classification",()=>{
  it("recognizes direct images",()=>expect(classifyLink("https://cdn.example/x/photo.webp")).toBe("direct-image"));
  it("recognizes Discourse topic links",()=>expect(classifyLink("https://forum.example/t/a-topic/123/7")).toBe("discourse"));
  it("recognizes generic pages",()=>expect(classifyLink("https://example.com/article")).toBe("generic"));
  it("ignores downloads",()=>expect(classifyLink("https://example.com/file.zip")).toBe("download"));
});

describe("canonical media URLs",()=>{
  it("strips common tracking parameters",()=>{
    expect(canonicalMediaUrl("https://x.test/a.jpg?utm_source=x&keep=1#z")).toBe("https://x.test/a.jpg?keep=1");
  });
  it("normalizes Discourse optimized image paths",()=>{
    expect(canonicalMediaUrl("https://files.example/optimized/4X/a/b/hash_2_690x388.jpeg")).toBe("https://files.example/original/4X/a/b/hash.jpeg");
  });
});
