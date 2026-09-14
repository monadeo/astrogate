import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

const valid = {
  github: { org: "acme", owner: "astro", appId: 1, appSlug: "astrogate", installationId: 2, projectNumber: 3 },
  listen: { host: "127.0.0.1", port: 8787, path: "/webhook" },
  defaults: { tier: "critical", checkScript: "pnpm check", deploy: { strategy: "tags", qa: "deploy-qa.yml", production: { workflow: "deploy-live.yml", inputs: { tag: "{tag}" } } } },
  repos: [{ repo: "acme/app" }, { repo: "acme/tool", tier: "non-critical", checkScript: "npm test" }],
  concurrency: { workers: 2 },
  attemptCap: 3,
  reminders: { afterMinutes: 240 },
  worker: { reposDir: "/w/repos", worktreesDir: "/w/trees" },
  models: {
    foreman: { model: "gpt-5.6-sol", thinking: "high" },
    worker: { model: "gpt-5.6-terra", thinking: "medium" },
    reviewer: { model: "gpt-5.6-sol", thinking: "high" },
  },
};

describe("parseConfig", () => {
  it("fills repos from defaults and keeps overrides", () => {
    const config = parseConfig(valid);
    expect(config.repos[0]).toEqual({ repo: "acme/app", owner: "astro", tier: "critical", checkScript: "pnpm check", deploy: { strategy: "tags", qa: { workflow: "deploy-qa.yml", inputs: {} }, production: { workflow: "deploy-live.yml", inputs: { tag: "{tag}" } } } });
    expect(config.repos[1].tier).toBe("non-critical");
    expect(config.repos[1].checkScript).toBe("npm test");
  });
  it("requires a QA workflow for critical repos", () => {
    const broken = { ...valid, defaults: { ...valid.defaults, deploy: { strategy: "tags", production: "live.yml" } } };
    expect(() => parseConfig(broken)).toThrow(/critical repos need a QA deploy workflow/);
  });
  it("rejects an unknown thinking level", () => {
    const broken = { ...valid, models: { ...valid.models, worker: { model: "x", thinking: "turbo" } } };
    expect(() => parseConfig(broken)).toThrow(/thinking must be one of/);
  });
  it("rejects a missing section instead of defaulting", () => {
    const broken: Record<string, unknown> = { ...valid };
    delete broken["reminders"];
    expect(() => parseConfig(broken)).toThrow(/reminders must be an object/);
  });
});
