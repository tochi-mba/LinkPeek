import {describe,expect,it} from "vitest";
import {parsePreloadedDiscourseTopic} from "../../src/core/discourse";

describe("Discourse embedded topic data",()=>{
  it("parses modern data-preloaded topic payloads",()=>{
    const topic={id:700,title:"Fixture",post_stream:{stream:[11],posts:[{id:11,post_number:29,username:"user",cooked:"<p>hello</p>",post_url:"/t/fixture/700/29"}]}};
    const preload=JSON.stringify({topic_700:JSON.stringify(topic)});
    const html=`<!doctype html><meta name="generator" content="Discourse 2026"><script type="application/json" id="data-preloaded">${preload}</script>`;
    expect(parsePreloadedDiscourseTopic(html,700)).toEqual(topic);
  });
  it("returns null for pages without a matching preloaded topic",()=>{
    expect(parsePreloadedDiscourseTopic("<html></html>",700)).toBeNull();
  });
});
