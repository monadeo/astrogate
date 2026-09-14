import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig, loadSecrets } from "../config.js";
import { GitHubApp } from "../github/client.js";
import { ensureBoard } from "../github/projects.js";
import type { Paths } from "../paths.js";

/** Needs the App installed on the org with organization Projects write. */
export async function initBoard(paths: Paths, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { title: { type: "string", default: "AstroGate" }, number: { type: "string" } } });
  const config = loadConfig(paths);
  const secrets = loadSecrets(paths);
  if (config.github.installationId === 0) throw new ConfigError("set github.installationId first (install the App on the org)");
  const github = new GitHubApp(config.github.appId, secrets.appPrivateKey, config.github.installationId);
  const wanted = values.number === undefined ? undefined : Number(values.number);
  if (wanted !== undefined && !Number.isInteger(wanted)) throw new ConfigError("--number must be an integer");
  const { number, created } = await ensureBoard(github, config.github.org, values.title ?? "AstroGate", wanted);
  const raw = JSON.parse(readFileSync(paths.config, "utf8")) as { github: Record<string, unknown> };
  raw.github["projectNumber"] = number;
  writeFileSync(paths.config, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  console.log(`Board ${created ? "created" : "adopted"}: https://github.com/orgs/${config.github.org}/projects/${number} (github.projectNumber set to ${number})`);
}
