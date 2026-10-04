import {describe,expect,it} from "vitest";
import {formatMediaTime,gifDuration,gifFrameDelay,gifTimeAtFrame} from "../../src/ui/gif-player";

describe("GIF timeline helpers",()=>{
  const frames=[{delay:100},{delay:150},{delay:0}];
  it("clamps invalid/too-short frame delays",()=>{expect(gifFrameDelay({delay:0})).toBe(100);expect(gifFrameDelay({delay:5})).toBe(20)});
  it("computes frame time and duration",()=>{expect(gifTimeAtFrame(frames,2)).toBe(250);expect(gifDuration(frames)).toBe(350)});
  it("formats media time with hundredths",()=>expect(formatMediaTime(61230)).toBe("1:01.23"));
});
