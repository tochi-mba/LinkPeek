import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
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
    onboarding: "src/pages/onboarding.ts"
  },
  bundle: true,
  outdir: out,
  format: "iife",
  target: "chrome120",
  sourcemap: false,
  minify: false
});

await cp("public", out, { recursive: true });
console.log("Built LinkPeek extension to dist/");
