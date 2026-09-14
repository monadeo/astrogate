import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig, loadSecrets } from "../config.js";
import { GitHubApp } from "../github/client.js";
import { createBoard } from "../github/projects.js";
import type { Paths } from "../paths.js";

/** Needs the App installed on the org with organization Projects write. */
export async function initBoard(paths: Paths, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { title: { type: "string", default: "Astrogate" } } });
  const config = loadConfig(paths);
  const secrets = loadSecrets(paths);
  if (config.github.installationId === 0) throw new ConfigError("set github.installationId first (install the App on the org)");
  const github = new GitHubApp(config.github.appId, secrets.appPrivateKey, config.github.installationId);
  const number = await createBoard(github, config.github.org, values.title ?? "Astrogate");
  const raw = JSON.parse(readFileSync(paths.config, "utf8")) as { github: Record<string, unknown> };
  raw.github["projectNumber"] = number;
  writeFileSync(paths.config, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  console.log(`Board created: https://github.com/orgs/${config.github.org}/projects/${number} (github.projectNumber set to ${number})`);
}
