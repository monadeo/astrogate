import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/companion.js",
  sourcemap: true,
  external: ["@earendil-works/*"],
});
