import {readFile,readdir,stat} from "node:fs/promises";import {join,dirname,resolve} from "node:path";
const root=resolve("site"),allowMissingDownloads=process.env.ALLOW_MISSING_DOWNLOADS==="1";const files=[];
async function walk(p){for(const n of await readdir(p)){const f=join(p,n);(await stat(f)).isDirectory()?await walk(f):files.push(f)}}await walk(root);
let bad=0;
for(const f of files.filter(x=>x.endsWith(".html"))){
  const html=await readFile(f,"utf8");
  // A broken edit once multiplied a page to megabytes while every link still resolved.
  if(html.length>200_000){console.error(`${f}: ${html.length} bytes is far too large for a site page`);bad++}
  if((html.match(/<html\b/gi)??[]).length!==1||(html.match(/<\/html>/gi)??[]).length!==1){console.error(`${f}: expected exactly one <html> element`);bad++}
  for(const m of html.matchAll(/(?:href|src)=["']([^"'#]+)["']/g)){
    const h=m[1];if(/^(https?:|mailto:)/.test(h))continue;if(h.startsWith("downloads/")&&allowMissingDownloads)continue;
    const target=resolve(dirname(f),h);try{await stat(target)}catch{console.error(`${f}: broken link ${h}`);bad++}
  }
  // Clicking a .crx makes the browser try to install it, which fails for self-hosted packages
  // (CRX_REQUIRED_PROOF_MISSING); the site offers the ZIP, which saves like any other file.
  // Only the click-to-install steps (shown to browsers that allow it once a flag is set) may link the CRX.
  for(const m of html.matchAll(/<a\b[^>]*href=["']downloads\/LinkPeek\.crx["'][^>]*>/gi)){
    if(!/\bdata-requires-flag\b/.test(m[0])){console.error(`${f}: link LinkPeek.zip; a CRX link needs data-requires-flag`);bad++}
  }
  for(const m of html.matchAll(/<a\b[^>]*href=["']downloads\/LinkPeek\.zip["'][^>]*>/gi)){
    if(!/\bdownload(?:=|\s|>)/i.test(m[0])){console.error(`${f}: the ZIP link must be a download`);bad++}
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
console.log(`Checked ${files.length} site files and install guidance${allowMissingDownloads?" (release downloads optional)":""}`);
