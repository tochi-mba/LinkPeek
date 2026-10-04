import {performance} from "node:perf_hooks";
import {spawnSync} from "node:child_process";
import {mkdir,readdir,readFile,stat,writeFile,rm} from "node:fs/promises";
import {resolve,relative,extname} from "node:path";
import {gzipSync,brotliCompressSync} from "node:zlib";
import {build} from "esbuild";

const root=resolve("."),base=resolve("baseline");await mkdir(base,{recursive:true});
const round=n=>Math.round(n*1000)/1000;
function run(cmd,args,env={}){
  const t=performance.now();const r=spawnSync(cmd,args,{cwd:root,stdio:"inherit",env:{...process.env,...env}});
  if(r.status!==0)throw new Error(`${cmd} ${args.join(" ")} failed with ${r.status}`);
  return round(performance.now()-t);
}
async function walk(dir){
  const out=[];for(const name of await readdir(dir)){const p=resolve(dir,name),s=await stat(p);if(s.isDirectory())out.push(...await walk(p));else out.push(p)}return out;
}
function compressed(buffer){return {raw:buffer.byteLength,gzip:gzipSync(buffer,{level:9}).byteLength,brotli:brotliCompressSync(buffer).byteLength}}
function groupInput(path){
  if(path.includes("node_modules/gifuct-js"))return "dependency:gifuct-js";
  if(path.includes("node_modules/"))return "dependency:other";
  if(path.includes("src/ui/gif-player"))return "src:gif-player";
  if(path.includes("src/ui/"))return "src:ui-other";
  if(path.includes("src/core/"))return "src:core";
  if(path.includes("src/shared/"))return "src:shared";
  if(path.includes("src/pages/"))return "src:pages";
  return "src:other";
}
async function bundleAnalysis(minify,outdir){
  await rm(outdir,{recursive:true,force:true});
  const result=await build({entryPoints:{background:"src/background.ts",content:"src/content.ts",popup:"src/pages/popup.ts",options:"src/pages/options.ts",onboarding:"src/pages/onboarding.ts"},bundle:true,outdir,format:"iife",target:"chrome120",minify,metafile:true,write:true});
  const files=await walk(outdir),sizes={};for(const f of files){const b=await readFile(f);sizes[relative(outdir,f)]=compressed(b)}
  const contribution={};
  for(const [outfile,meta] of Object.entries(result.metafile.outputs)){
    const key=relative(outdir,resolve(outfile)),groups={};
    for(const [input,detail] of Object.entries(meta.inputs||{})){const g=groupInput(input);groups[g]=(groups[g]||0)+(detail.bytesInOutput||0)}
    contribution[key]=groups;
  }
  return {sizes,contribution};
}

const result={generatedAt:new Date().toISOString(),commands:{},artifacts:{},bundles:{},source:{}};
result.commands.typecheck_ms=run("npm",["run","typecheck"]);
result.commands.unit_tests_ms=run("npm",["test"]);
result.commands.build_ms=run("npm",["run","build"]);

const distFiles=await walk(resolve("dist"));let totalRaw=0,totalGzip=0,totalBrotli=0;const files={};
for(const f of distFiles){const b=await readFile(f),c=compressed(b),name=relative(resolve("dist"),f);files[name]=c;totalRaw+=c.raw;if([".js",".css",".html",".json"].includes(extname(f))) {totalGzip+=c.gzip;totalBrotli+=c.brotli}else{totalGzip+=c.raw;totalBrotli+=c.raw}}
result.artifacts={file_count:distFiles.length,total:{raw:totalRaw,gzip_equivalent:totalGzip,brotli_equivalent:totalBrotli},files};

result.bundles.current=await bundleAnalysis(false,resolve("baseline/analyze-current"));
result.bundles.minified_hypothetical=await bundleAnalysis(true,resolve("baseline/analyze-minified"));

const sourceFiles=(await Promise.all(["src","public","site","tests","scripts"].map(async d=>{try{return await walk(resolve(d))}catch{return []}}))).flat();
let bytes=0,lines=0;for(const f of sourceFiles){const b=await readFile(f);bytes+=b.byteLength;if(/\.(ts|js|mjs|css|html|json)$/.test(f))lines+=b.toString("utf8").split("\n").length}
result.source={file_count:sourceFiles.length,bytes,lines};

await build({entryPoints:["benchmarks/node-baseline.ts"],bundle:true,platform:"node",format:"esm",target:"node24",outfile:"baseline/node-bench.mjs"});
result.commands.node_microbench_ms=run(process.execPath,["--expose-gc","baseline/node-bench.mjs"],{BASELINE_NODE_OUT:"baseline/node.json"});
await writeFile("baseline/build.json",JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
