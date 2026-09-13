import { readFileSync } from "node:fs";
import type { Role } from "@monadeo.com/astrogate-protocol";
import type { Paths } from "./paths.js";

export type Tier = "critical" | "non-critical";

export interface ProjectConfig {
  repo: string;
  tier: Tier;
  checkScript: string;
  deploy: { qa?: string; production: string; qaUrl?: string };
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Config {
  github: { org: string; owner: string; appId: number; appSlug: string; installationId: number; projectNumber: number };
  listen: { host: string; port: number; path: string };
  projects: ProjectConfig[];
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

function parseProject(value: unknown, index: number): ProjectConfig {
  const where = `projects[${index}]`;
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object`);
  const repo = str(value, "repo", where);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ConfigError(`${where}.repo must be owner/name`);
  const tier = str(value, "tier", where);
  if (tier !== "critical" && tier !== "non-critical") throw new ConfigError(`${where}.tier must be critical or non-critical`);
  const deploy = section(value, "deploy");
  const qa = optStr(deploy, "qa", `${where}.deploy`);
  const qaUrl = optStr(deploy, "qaUrl", `${where}.deploy`);
  if (tier === "critical" && qa === undefined) throw new ConfigError(`${where}.deploy.qa is required for critical projects`);
  return {
    repo,
    tier,
    checkScript: str(value, "checkScript", where),
    deploy: { production: str(deploy, "production", `${where}.deploy`), ...(qa ? { qa } : {}), ...(qaUrl ? { qaUrl } : {}) },
  };
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
  const projects = raw["projects"];
  if (!Array.isArray(projects)) throw new ConfigError("projects must be an array");
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
    projects: projects.map(parseProject),
    concurrency: { workers: num(concurrency, "workers", "concurrency") },
    attemptCap: num(raw, "attemptCap", "config"),
    reminders: { afterMinutes: num(reminders, "afterMinutes", "reminders") },
    worker: { reposDir: str(worker, "reposDir", "worker"), worktreesDir: str(worker, "worktreesDir", "worker") },
    models: parseModels(raw),
  };
}

export function findProject(config: Config, repo: string): ProjectConfig | undefined {
  return config.projects.find((p) => p.repo.toLowerCase() === repo.toLowerCase());
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
