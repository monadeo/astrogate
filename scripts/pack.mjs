#!/usr/bin/env node
// Assembles the release tarball from the built bundles. CI runs this after
// `pnpm build`; run it locally to inspect the layout.
//
//   astrogate-<version>/
//     bin/astrogate          controller bundle, executable
//     lib/companion.js       Pi extension bundle
//     LICENSE  README.md
import { execSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const name = `astrogate-${version}`;
const out = "dist-release";
const stage = join(out, name);

const inputs = {
  "bin/astrogate": "packages/controller/dist/index.js",
  "lib/companion.js": "packages/companion/dist/companion.js",
  LICENSE: "LICENSE",
  "README.md": "README.md",
};

for (const src of Object.values(inputs)) {
  if (!existsSync(src)) {
    console.error(`Missing ${src}. Run \`pnpm build\` first.`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
for (const [dest, src] of Object.entries(inputs)) {
  const target = join(stage, dest);
  mkdirSync(join(target, ".."), { recursive: true });
  copyFileSync(src, target);
}
chmodSync(join(stage, "bin/astrogate"), 0o755);

const tarball = join(out, `${name}.tar.gz`);
execSync(`tar -czf ${name}.tar.gz ${name}`, { cwd: out, stdio: "inherit" });
const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(`${tarball}.sha256`, `${sha256}  ${name}.tar.gz\n`);
console.log(`${tarball}\n${sha256}`);
