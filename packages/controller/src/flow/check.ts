import { spawn } from "node:child_process";

export interface CheckOutcome {
  ok: boolean;
  output: string;
}

const CHECK_TIMEOUT_MS = 30 * 60_000;

/** Runs the project's check script in the worktree and keeps the tail of its output. */
export function runCheck(worktree: string, script: string): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", script], { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-20_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      output += "\n[astrogate] check timed out";
    }, CHECK_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${output}\n${error.message}` });
    });
  });
}
