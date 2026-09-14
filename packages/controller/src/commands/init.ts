import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Paths } from "../paths.js";

/**
 * GitHub App manifest flow, in two steps so it works over SSH:
 *   1. `astrogate init app --org ORG --webhook-url URL` prints a form page path; open it, click Create.
 *      GitHub redirects to a localhost URL that will not load; copy the `code` from it.
 *   2. `astrogate init app --code CODE` exchanges the code and writes config and secrets.
 */

const PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  actions: "write",
  checks: "write",
  metadata: "read",
  organization_projects: "write",
} as const;

const EVENTS = ["issues", "issue_comment", "pull_request", "pull_request_review", "check_suite", "workflow_run", "release", "projects_v2_item"];

export function manifestFormHtml(org: string, webhookUrl: string): string {
  const manifest = {
    name: "AstroGate",
    url: "https://github.com/monadeo/astrogate",
    hook_attributes: { url: webhookUrl, active: true },
    redirect_url: "http://127.0.0.1:1/astrogate-init",
    public: false,
    default_permissions: PERMISSIONS,
    default_events: EVENTS,
  };
  const state = randomBytes(8).toString("hex");
  const action = `https://github.com/organizations/${org}/settings/apps/new?state=${state}`;
  const escaped = JSON.stringify(manifest).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<!doctype html><title>Register Astrogate</title>
<form action="${action}" method="post">
<input type="hidden" name="manifest" value="${escaped}">
<button type="submit">Register the Astrogate GitHub App on ${org}</button>
</form>`;
}

interface Conversion {
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
}

export async function exchangeManifestCode(code: string): Promise<Conversion> {
  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "astrogate" },
  });
  if (!response.ok) throw new Error(`manifest conversion failed: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as Partial<Conversion>;
  if (typeof data.id !== "number" || typeof data.slug !== "string" || typeof data.pem !== "string" || typeof data.webhook_secret !== "string") {
    throw new Error("manifest conversion returned an unexpected shape");
  }
  return { id: data.id, slug: data.slug, pem: data.pem, webhook_secret: data.webhook_secret };
}

export function writeAppSecrets(paths: Paths, conversion: Conversion): void {
  mkdirSync(paths.secrets, { recursive: true, mode: 0o700 });
  writeFileSync(paths.appPrivateKey, conversion.pem, { mode: 0o600 });
  writeFileSync(paths.webhookSecret, `${conversion.webhook_secret}\n`, { mode: 0o600 });
}

export function writeInitialConfig(paths: Paths, org: string, appId: number, appSlug: string, listenPort: number, webhookPath: string): void {
  if (existsSync(paths.config)) return;
  const config = {
    github: { org, owner: "", appId, appSlug, installationId: 0, projectNumber: 0 },
    listen: { host: "127.0.0.1", port: listenPort, path: webhookPath },
    defaults: { tier: "critical", checkScript: "pnpm check", deploy: { qa: "deploy-qa.yml", production: "deploy-live.yml" } },
    repos: [],
    concurrency: { workers: 2 },
    attemptCap: 3,
    reminders: { afterMinutes: 240 },
    worker: { reposDir: "", worktreesDir: "" },
    models: {
      foreman: { model: "gpt-5.6-sol", thinking: "high" },
      worker: { model: "gpt-5.6-terra", thinking: "medium" },
      reviewer: { model: "gpt-5.6-sol", thinking: "high" },
    },
  };
  writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
