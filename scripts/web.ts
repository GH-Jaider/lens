// Builds the pages' TypeScript (web/src) into the scripts Lens serves
// (web/dist). build.rs runs this, so `cargo build` is enough.
import { build } from "esbuild"

await build({
  entryPoints: ["web/src/app.ts", "web/src/phone.ts", "web/src/view.ts"],
  outdir: "web/dist",
  bundle: true,
  minify: true,
  format: "iife",
  // Phones a few years old still have to open the page.
  target: ["safari15", "chrome100"],
  logLevel: "warning",
})
