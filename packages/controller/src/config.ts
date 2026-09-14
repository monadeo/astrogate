import { readFileSync } from "node:fs";
import type { Role } from "@monadeo.com/astrogate-protocol";
import type { Paths } from "./paths.js";

export type Tier = "critical" | "non-critical";

export interface DeployTarget {
  workflow: string;
  /** Static workflow_dispatch inputs; "{ref}" expands to the dispatched ref. */
  inputs: Record<string, string>;
}

/**
 * tags: QA runs on a release-candidate tag push, production is dispatched with the final tag ("{tag}").
 * dispatch: both workflows are dispatched on a ref ("{ref}").
 */
export type DeployStrategy = "tags" | "dispatch";

export interface RepoConfig {
  repo: string;
  tier: Tier;
  checkScript: string;
  deploy: { strategy: DeployStrategy; qa?: DeployTarget; production: DeployTarget; qaUrl?: string };
}

export interface RepoDefaults {
  tier: Tier;
  checkScript: string;
  deploy: { strategy: DeployStrategy; qa?: DeployTarget; production: DeployTarget };
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Config {
  github: { org: string; owner: string; appId: number; appSlug: string; installationId: number; projectNumber: number };
  listen: { host: string; port: number; path: string };
  defaults: RepoDefaults;
  repos: RepoConfig[];
  concurrency: { workers: number };
  attemptCap: number;
  reminders: { afterMinutes: number };
  worker: { reposDir: string; worktreesDir: string };
  models: Record<Role, { model: string; thinking: ThinkingLevel }>;
}

export interface Secrets {
  appPrivateKey: string;
  webhookSecret: string;
  discordWebhookUrl: string;
}

class ConfigError extends Error {}

const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ROLES: Role[] = ["foreman", "worker", "reviewer"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) throw new ConfigError(`${where}.${key} must be a non-empty string`);
  return v;
}

function optStr(obj: Record<string, unknown>, key: string, where: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0) throw new ConfigError(`${where}.${key} must be a non-empty string`);
  return v;
}

function num(obj: Record<string, unknown>, key: string, where: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new ConfigError(`${where}.${key} must be a positive integer`);
  return v;
}

function section(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  if (!isRecord(v)) throw new ConfigError(`${key} must be an object`);
  return v;
}

function parseTier(value: unknown, where: string): Tier {
  if (value !== "critical" && value !== "non-critical") throw new ConfigError(`${where} must be critical or non-critical`);
  return value;
}

function parseTarget(value: unknown, where: string): DeployTarget {
  if (typeof value === "string" && value.length > 0) return { workflow: value, inputs: {} };
  if (!isRecord(value)) throw new ConfigError(`${where} must be a workflow file name or { workflow, inputs }`);
  const workflow = str(value, "workflow", where);
  const rawInputs = value["inputs"] ?? {};
  if (!isRecord(rawInputs)) throw new ConfigError(`${where}.inputs must be an object of strings`);
  const inputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawInputs)) {
    if (typeof v !== "string") throw new ConfigError(`${where}.inputs.${k} must be a string`);
    inputs[k] = v;
  }
  return { workflow, inputs };
}

function parseStrategy(value: unknown, where: string): DeployStrategy {
  if (value !== "tags" && value !== "dispatch") throw new ConfigError(`${where} must be tags or dispatch`);
  return value;
}

function parseDefaults(raw: Record<string, unknown>): RepoDefaults {
  const defaults = section(raw, "defaults");
  const deploy = section(defaults, "deploy");
  const qa = deploy["qa"];
  return {
    tier: parseTier(defaults["tier"], "defaults.tier"),
    checkScript: str(defaults, "checkScript", "defaults"),
    deploy: {
      strategy: parseStrategy(deploy["strategy"], "defaults.deploy.strategy"),
      production: parseTarget(deploy["production"], "defaults.deploy.production"),
      ...(qa === undefined ? {} : { qa: parseTarget(qa, "defaults.deploy.qa") }),
    },
  };
}

function parseRepo(value: unknown, index: number, defaults: RepoDefaults): RepoConfig {
  const where = `repos[${index}]`;
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object`);
  const repo = str(value, "repo", where);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ConfigError(`${where}.repo must be owner/name`);
  const tier = value["tier"] === undefined ? defaults.tier : parseTier(value["tier"], `${where}.tier`);
  const checkScript = value["checkScript"] === undefined ? defaults.checkScript : str(value, "checkScript", where);
  const deployRaw = value["deploy"] === undefined ? {} : section(value, "deploy");
  const production = deployRaw["production"] === undefined ? defaults.deploy.production : parseTarget(deployRaw["production"], `${where}.deploy.production`);
  const qa = deployRaw["qa"] === undefined ? defaults.deploy.qa : parseTarget(deployRaw["qa"], `${where}.deploy.qa`);
  const qaUrl = optStr(deployRaw, "qaUrl", `${where}.deploy`);
  const strategy = deployRaw["strategy"] === undefined ? defaults.deploy.strategy : parseStrategy(deployRaw["strategy"], `${where}.deploy.strategy`);
  if (tier === "critical" && qa === undefined) throw new ConfigError(`${where}: critical repos need a QA deploy workflow (repo or defaults)`);
  return { repo, tier, checkScript, deploy: { strategy, production, ...(qa ? { qa } : {}), ...(qaUrl ? { qaUrl } : {}) } };
}

function parseModels(raw: Record<string, unknown>): Config["models"] {
  const models = section(raw, "models");
  const out = {} as Config["models"];
  for (const role of ROLES) {
    const entry = section(models, role);
    const thinking = str(entry, "thinking", `models.${role}`);
    if (!THINKING.includes(thinking as ThinkingLevel)) throw new ConfigError(`models.${role}.thinking must be one of ${THINKING.join(", ")}`);
    out[role] = { model: str(entry, "model", `models.${role}`), thinking: thinking as ThinkingLevel };
  }
  return out;
}

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new ConfigError("config must be a JSON object");
  const github = section(raw, "github");
  const listen = section(raw, "listen");
  const concurrency = section(raw, "concurrency");
  const reminders = section(raw, "reminders");
  const worker = section(raw, "worker");
  const repos = raw["repos"];
  if (!Array.isArray(repos)) throw new ConfigError("repos must be an array");
  const defaults = parseDefaults(raw);
  return {
    github: {
      org: str(github, "org", "github"),
      owner: str(github, "owner", "github"),
      appId: num(github, "appId", "github"),
      appSlug: str(github, "appSlug", "github"),
      installationId: num(github, "installationId", "github"),
      projectNumber: num(github, "projectNumber", "github"),
    },
    listen: { host: str(listen, "host", "listen"), port: num(listen, "port", "listen"), path: str(listen, "path", "listen") },
    defaults,
    repos: repos.map((r, i) => parseRepo(r, i, defaults)),
    concurrency: { workers: num(concurrency, "workers", "concurrency") },
    attemptCap: num(raw, "attemptCap", "config"),
    reminders: { afterMinutes: num(reminders, "afterMinutes", "reminders") },
    worker: { reposDir: str(worker, "reposDir", "worker"), worktreesDir: str(worker, "worktreesDir", "worker") },
    models: parseModels(raw),
  };
}

export function findRepo(config: Config, repo: string): RepoConfig | undefined {
  return config.repos.find((p) => p.repo.toLowerCase() === repo.toLowerCase());
}

export function loadConfig(paths: Paths): Config {
  let text: string;
  try {
    text = readFileSync(paths.config, "utf8");
  } catch {
    throw new ConfigError(`No config at ${paths.config}. Run \`astrogate init\` first.`);
  }
  return parseConfig(JSON.parse(text));
}

function readSecret(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    throw new ConfigError(`Missing secret file ${path}`);
  }
}

export function loadSecrets(paths: Paths): Secrets {
  return {
    appPrivateKey: readSecret(paths.appPrivateKey),
    webhookSecret: readSecret(paths.webhookSecret),
    discordWebhookUrl: readSecret(paths.discordWebhookUrl),
  };
}

export { ConfigError };
