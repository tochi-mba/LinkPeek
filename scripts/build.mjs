import { build } from "esbuild";
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const out = resolve("dist");
if (process.argv.includes("--clean")) {
  await rm(out, { recursive: true, force: true });
  process.exit(0);
}
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    popup: "src/pages/popup.ts",
    options: "src/pages/options.ts",
    onboarding: "src/pages/onboarding.ts",
    mirror: "src/pages/mirror.ts"
  },
  bundle: true,
  outdir: out,
  format: "iife",
  target: "chrome120",
  sourcemap: false,
  minify: true
});

await build({
  entryPoints: {"gif-player":"src/ui/gif-player.ts"},
  bundle: true,
  outdir: out,
  format: "esm",
  target: "chrome120",
  sourcemap: false,
  minify: true
});

await cp("public", out, { recursive: true });
await cp("src/pages/base.css", resolve(out, "base.css"));
const icons=JSON.parse(await readFile("assets/icons.json","utf8"));
await mkdir(resolve(out,"icons"),{recursive:true});
for(const [size,data] of Object.entries(icons)) await writeFile(resolve(out,"icons",`icon${size}.png`),Buffer.from(data,"base64"));
await writeFile(resolve("site","favicon.png"),Buffer.from(icons["48"],"base64"));
console.log("Built LinkPeek extension to dist/");
