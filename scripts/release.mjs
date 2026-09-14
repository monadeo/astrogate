#!/usr/bin/env node
// Lockstep release: the root and all packages share one version so the
// release workflow and the Homebrew formula bump always agree.
// After the tag push, waits for the GitHub Actions release run and reports it.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const type = process.argv[2];
if (!["patch", "minor", "major"].includes(type ?? "")) {
  console.error("Usage: node scripts/release.mjs <patch|minor|major>");
  process.exit(1);
}

const run = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", ...opts });
const capture = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();

const packageDirs = [".", "packages/protocol", "packages/controller", "packages/companion"];
const manifests = packageDirs.map((dir) => (dir === "." ? "package.json" : `${dir}/package.json`));

const versions = packageDirs.map(
  (dir) => JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version,
);
if (new Set(versions).size !== 1) {
  console.error(
    `Lockstep broken; package versions diverge:\n${manifests.map((m, i) => `  ${m}: ${versions[i]}`).join("\n")}\nAlign them before releasing.`,
  );
  process.exit(1);
}

function bump(current, releaseType) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) {
    console.error(`Cannot parse current version "${current}" as major.minor.patch.`);
    process.exit(1);
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  if (releaseType === "major") return `${major + 1}.0.0`;
  if (releaseType === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

if (capture("git status --porcelain")) {
  console.error("Working tree is not clean. Commit or stash before releasing.");
  process.exit(1);
}
if (capture("git branch --show-current") !== "main") {
  console.error("Releases are cut from main.");
  process.exit(1);
}

const next = bump(versions[0], type);
const tag = `v${next}`;

run("pnpm check");

try {
  for (const dir of packageDirs) {
    // --allow-same-version makes a rerun after a partial failure idempotent.
    run(`npm version ${next} --no-git-tag-version --allow-same-version`, { cwd: dir });
  }
  run(`git add ${manifests.join(" ")}`);
  // [skip ci] keeps the push from starting a ci run; the release workflow is dispatched below.
  run(`git commit -m "Release ${tag} [skip ci]"`);
  // Annotated tag: `git push --follow-tags` only pushes annotated tags, and the
  // tag push is what triggers the release workflow.
  run(`git tag -a ${tag} -m ${tag}`);
  run("git push --follow-tags");
} catch (err) {
  run(`git checkout -- ${manifests.join(" ")}`);
  console.error(`Release failed; package.json bumps rolled back: ${err?.message ?? err}`);
  process.exit(1);
}

// Start the release workflow on the tag, then stream it.
run(`gh workflow run release.yml --ref ${tag}`);
let runId = "";
for (let attempt = 0; attempt < 30 && !runId; attempt += 1) {
  runId = capture(
    `gh run list --workflow release.yml --branch ${tag} --limit 1 --json databaseId --jq '.[0].databaseId // empty'`,
  );
  if (!runId) await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (!runId) {
  console.error(`Tag ${tag} pushed and workflow dispatched, but no run appeared within 150 s. Check: gh run list --workflow release.yml`);
  process.exit(1);
}
run(`gh run watch ${runId} --exit-status`);
console.log(`Released ${tag}. Install or upgrade with: brew upgrade astrogate`);
