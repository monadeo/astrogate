import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Role } from "@monadeo.com/astrogate-protocol";
import type { Config } from "../config.js";
import { agentStart, herdr, paneRun, worktreeCreate, worktreeOpen, type WorktreeHandle } from "../herdr/cli.js";

export interface LaunchTarget {
  role: Role;
  repo: string;
  ticket: number;
  attempt: number;
  /** Working directory of the pane: the worktree for workers and reviewers, the clone for the foreman. */
  cwd: string;
  sessionFile?: string;
}

export interface Launched {
  workspaceId: string;
  paneId: string;
}

/** The companion bundle ships next to the controller: bin/astrogate and lib/companion.js. */
export function companionPath(): string {
  const bin = realpathSync(process.argv[1] ?? "");
  return join(dirname(bin), "..", "lib", "companion.js");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function piArgs(config: Config, target: LaunchTarget): string[] {
  const model = config.models[target.role];
  const args = ["-e", companionPath(), "--provider", "openai-codex", "--model", model.model, "--thinking", model.thinking];
  if (target.sessionFile) args.push("--session", target.sessionFile);
  return args;
}

function sessionEnv(socketPath: string, target: LaunchTarget): Record<string, string> {
  return {
    ASTROGATE_SOCKET: socketPath,
    ASTROGATE_ROLE: target.role,
    ASTROGATE_REPO: target.repo,
    ASTROGATE_TICKET: String(target.ticket),
    ASTROGATE_ATTEMPT: String(target.attempt),
  };
}

export function agentName(target: LaunchTarget): string {
  return `${target.role[0]}${target.ticket}-${target.attempt}`.slice(0, 32);
}

/** Creates a git worktree workspace for a worker and starts Pi in its root pane. */
export async function launchInWorktree(config: Config, socketPath: string, target: LaunchTarget, repoDir: string, branch: string, base: string, existing: boolean): Promise<Launched & WorktreeHandle> {
  const handle = existing
    ? await worktreeOpen(repoDir, target.cwd)
    : await worktreeCreate(repoDir, branch, base, target.cwd);
  const env = Object.entries(sessionEnv(socketPath, target))
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join(" && ");
  await paneRun(handle.paneId, env);
  await agentStart(agentName(target), handle.paneId, piArgs(config, target));
  return { ...handle, workspaceId: handle.workspaceId, paneId: handle.paneId };
}

/** Creates a plain workspace (foreman, reviewer) and starts Pi in its root pane. */
export async function launchInWorkspace(config: Config, socketPath: string, target: LaunchTarget, label: string): Promise<Launched> {
  const envArgs = Object.entries(sessionEnv(socketPath, target)).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  const result = await herdr(["workspace", "create", "--cwd", target.cwd, "--label", label, "--no-focus", ...envArgs]);
  const workspace = result["workspace"];
  const pane = result["root_pane"];
  const workspaceId = typeof workspace === "object" && workspace !== null ? String((workspace as Record<string, unknown>)["workspace_id"]) : "";
  const paneId = typeof pane === "object" && pane !== null ? String((pane as Record<string, unknown>)["pane_id"]) : "";
  if (!workspaceId || !paneId) throw new Error("herdr workspace create returned no ids");
  await agentStart(agentName(target), paneId, piArgs(config, target));
  return { workspaceId, paneId };
}
