import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class HerdrError extends Error {
  readonly args: string[];
  readonly stderr: string;

  constructor(args: string[], stderr: string) {
    super(`herdr ${args.join(" ")} failed: ${stderr.trim().slice(0, 500)}`);
    this.args = args;
    this.stderr = stderr;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Runs the herdr CLI as the current user and returns its JSON result object. */
export async function herdr(args: string[]): Promise<Record<string, unknown>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("herdr", args, { maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    const stderr = isRecord(error) && typeof error["stderr"] === "string" ? error["stderr"] : String(error);
    throw new HerdrError(args, stderr);
  }
  const parsed: unknown = JSON.parse(stdout);
  if (!isRecord(parsed)) throw new HerdrError(args, `unexpected output: ${stdout.slice(0, 200)}`);
  const result = parsed["result"];
  return isRecord(result) ? result : parsed;
}

function pick(obj: Record<string, unknown>, path: string[]): string {
  let cursor: unknown = obj;
  for (const key of path) {
    if (!isRecord(cursor)) throw new Error(`herdr response lacks ${path.join(".")}`);
    cursor = cursor[key];
  }
  if (typeof cursor !== "string") throw new Error(`herdr response lacks ${path.join(".")}`);
  return cursor;
}

export interface WorktreeHandle {
  workspaceId: string;
  paneId: string;
  path: string;
}

export async function worktreeCreate(repoDir: string, branch: string, base: string, path: string): Promise<WorktreeHandle> {
  const result = await herdr([
    "worktree", "create", "--cwd", repoDir, "--branch", branch, "--base", base, "--path", path, "--no-focus", "--trust-repository",
  ]);
  return {
    workspaceId: pick(result, ["workspace", "workspace_id"]),
    paneId: pick(result, ["root_pane", "pane_id"]),
    path,
  };
}

export async function worktreeOpen(repoDir: string, path: string): Promise<WorktreeHandle> {
  const result = await herdr(["worktree", "open", "--cwd", repoDir, "--path", path, "--no-focus", "--trust-repository"]);
  return {
    workspaceId: pick(result, ["workspace", "workspace_id"]),
    paneId: pick(result, ["root_pane", "pane_id"]),
    path,
  };
}

export async function paneRun(paneId: string, command: string): Promise<void> {
  await herdr(["pane", "run", paneId, command]);
}

export async function agentStart(name: string, paneId: string, piArgs: string[]): Promise<void> {
  await herdr(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "120000", "--", ...piArgs]);
}

export async function paneClose(paneId: string): Promise<void> {
  await herdr(["pane", "close", paneId]);
}

export async function paneRead(paneId: string, lines = 80): Promise<string> {
  const { stdout } = await execFileAsync("herdr", ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)]);
  return stdout;
}
