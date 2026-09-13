import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  readonly stderr: string;

  constructor(args: string[], stderr: string) {
    super(`git ${args.slice(0, 3).join(" ")} failed: ${stderr.trim().slice(0, 800)}`);
    this.stderr = stderr;
  }
}

function isExecError(error: unknown): error is { stderr: string; stdout: string } {
  return typeof error === "object" && error !== null && "stderr" in error;
}

export async function git(cwd: string, args: string[], token?: string): Promise<GitResult> {
  // The token travels in a per-invocation header, never in .git/config.
  const auth = token ? ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: bearer ${token}`] : [];
  try {
    const { stdout, stderr } = await execFileAsync("git", [...auth, ...args], { cwd, maxBuffer: 32 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (error) {
    throw new GitError(args, isExecError(error) ? error.stderr : String(error));
  }
}

export function repoDir(reposDir: string, repo: string): string {
  return join(reposDir, repo);
}

/** Clones the repository once, then keeps its default branch current. */
export async function ensureClone(reposDir: string, repo: string, defaultBranch: string, token: string): Promise<string> {
  const dir = repoDir(reposDir, repo);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dirname(dir), { recursive: true });
    await git(dirname(dir), ["clone", "--quiet", `https://github.com/${repo}.git`, dir], token);
  }
  await git(dir, ["fetch", "--quiet", "--prune", "origin"], token);
  await git(dir, ["update-ref", `refs/heads/${defaultBranch}`, `refs/remotes/origin/${defaultBranch}`]);
  return dir;
}

export async function headSha(worktree: string): Promise<string> {
  return (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function currentBranch(worktree: string): Promise<string> {
  return (await git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
}

export async function isClean(worktree: string): Promise<boolean> {
  return (await git(worktree, ["status", "--porcelain"])).stdout.trim().length === 0;
}

export async function changedFiles(worktree: string, base: string): Promise<string[]> {
  const { stdout } = await git(worktree, ["diff", "--name-only", `${base}...HEAD`]);
  return stdout.split("\n").filter((line) => line.length > 0);
}

export async function commitCount(worktree: string, base: string): Promise<number> {
  return Number((await git(worktree, ["rev-list", "--count", `${base}..HEAD`])).stdout.trim());
}

export async function push(worktree: string, branch: string, token: string): Promise<void> {
  await git(worktree, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], token);
}
