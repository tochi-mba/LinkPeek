import {readFile,readdir,stat} from "node:fs/promises";import {join,dirname,resolve} from "node:path";
const root=resolve("site"),allowMissingDownloads=process.env.ALLOW_MISSING_DOWNLOADS==="1";const files=[];
async function walk(p){for(const n of await readdir(p)){const f=join(p,n);(await stat(f)).isDirectory()?await walk(f):files.push(f)}}await walk(root);
let bad=0;
for(const f of files.filter(x=>x.endsWith(".html"))){
  const html=await readFile(f,"utf8");
  for(const m of html.matchAll(/href=["']([^"'#]+)["']/g)){
    const h=m[1];if(/^(https?:|mailto:)/.test(h))continue;if(h.startsWith("downloads/")&&allowMissingDownloads)continue;
    const target=resolve(dirname(f),h);try{await stat(target)}catch{console.error(`${f}: broken link ${h}`);bad++}
  }
  for(const m of html.matchAll(/<a\b[^>]*href=["']downloads\/LinkPeek\.crx["'][^>]*>/gi)){
    if(!/\bdownload(?:=|\s|>)/i.test(m[0])){console.error(`${f}: CRX link must force download instead of direct navigation`);bad++}
  }
  const forbidden=[
    /open the downloaded extension/i,
    /open the package/i
  ];
  for(const pattern of forbidden){
    if(pattern.test(html)){console.error(`${f}: install copy suggests opening the CRX directly (${pattern})`);bad++}
  }
}
if(bad)process.exit(1);
console.log(`Checked ${files.length} site files and CRX install guidance${allowMissingDownloads?" (release downloads optional)":""}`);
