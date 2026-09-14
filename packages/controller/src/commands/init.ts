import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Paths } from "../paths.js";

/**
 * GitHub App manifest flow. `init app` serves a form page and a callback on 127.0.0.1;
 * the browser posts the manifest to GitHub, GitHub redirects back with a one-time code,
 * and the callback exchanges it for the App id, private key, and webhook secret.
 * `init app --code` remains for the case where the redirect could not be captured.
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

export function manifestFormHtml(org: string, webhookUrl: string, redirectUrl: string, state: string): string {
  const manifest = {
    name: "AstroGate",
    url: "https://github.com/monadeo/astrogate",
    hook_attributes: { url: webhookUrl, active: true },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: PERMISSIONS,
    default_events: EVENTS,
  };
  const action = `https://github.com/organizations/${org}/settings/apps/new?state=${state}`;
  const escaped = JSON.stringify(manifest).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<!doctype html><title>Register AstroGate</title>
<body style="font-family: system-ui; padding: 3rem">
<form action="${action}" method="post">
<input type="hidden" name="manifest" value="${escaped}">
<button type="submit" style="font-size: 1.2rem; padding: 1rem 2rem">Register the AstroGate GitHub App on ${org}</button>
</form></body>`;
}

export interface Conversion {
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
    defaults: { tier: "critical", checkScript: "pnpm check", deploy: { strategy: "tags", qa: "deploy-qa.yml", production: { workflow: "deploy-live.yml", inputs: { tag: "{tag}" } } } },
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

/** Serves the form and waits for GitHub's redirect; resolves with the exchanged credentials. */
export function registerInteractively(org: string, webhookUrl: string, callbackPort: number): Promise<Conversion> {
  const state = randomBytes(8).toString("hex");
  const redirectUrl = `http://127.0.0.1:${callbackPort}/callback`;
  const page = manifestFormHtml(org, webhookUrl, redirectUrl, state);
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${callbackPort}`);
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
        return;
      }
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("Missing code or state mismatch. Run astrogate init app again.");
        return;
      }
      exchangeManifestCode(code)
        .then((conversion) => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><body style="font-family: system-ui; padding: 3rem"><h1>AstroGate registered</h1><p>App ${conversion.slug} (id ${conversion.id}). You can close this tab.</p></body>`);
          server.close();
          resolve(conversion);
        })
        .catch((error: unknown) => {
          res.writeHead(500, { "Content-Type": "text/plain" }).end(String(error));
          server.close();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
    server.once("error", reject);
    server.listen(callbackPort, "127.0.0.1", () => {
      console.log(`Open http://127.0.0.1:${callbackPort}/ and click the button. Waiting for GitHub's redirect...`);
    });
  });
}
