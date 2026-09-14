import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);

const BOT_NAME = "astrogate[bot]";
const BOT_EMAIL = "astrogate[bot]@users.noreply.github.com";

export async function readPackageVersion(clone: string, ref: string): Promise<string> {
  const { stdout } = await git(clone, ["show", `${ref}:package.json`]);
  const parsed = JSON.parse(stdout) as { version?: unknown };
  if (typeof parsed.version !== "string") throw new Error(`package.json on ${ref} has no version`);
  return parsed.version;
}

/**
 * Sets package.json to `version` on `branch`, commits as the bot, pushes, and returns the new commit sha.
 * Works in a throwaway worktree so the clone's own checkout is untouched.
 */
export async function commitVersion(clone: string, branch: string, version: string, token: string): Promise<string> {
  await git(clone, ["fetch", "--quiet", "origin", branch], token);
  const dir = mkdtempSync(join(tmpdir(), "astrogate-release-"));
  try {
    await git(clone, ["worktree", "add", "--detach", dir, `origin/${branch}`]);
    const pkgPath = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    if (pkg["version"] === version) return (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    // npm rewrites package.json in place and keeps its formatting.
    await execFileAsync("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], { cwd: dir });
    await git(dir, ["add", "package.json"]);
    await git(dir, ["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, "commit", "-q", "-m", `Release v${version}`]);
    const sha = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    await git(dir, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], token);
    return sha;
  } finally {
    await git(clone, ["worktree", "remove", "--force", dir]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}
