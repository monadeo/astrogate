import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

const valid = {
  github: { org: "acme", owner: "astro", appId: 1, appSlug: "astrogate", installationId: 2, projectNumber: 3 },
  listen: { host: "127.0.0.1", port: 8787, path: "/webhook" },
  repos: [{ repo: "acme/app", tier: "critical", checkScript: "pnpm check", deploy: { qa: "qa.yml", production: "live.yml" } }],
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
  it("accepts a complete config", () => {
    expect(parseConfig(valid).repos[0].tier).toBe("critical");
  });
  it("requires a QA workflow for critical projects", () => {
    const broken = { ...valid, repos: [{ ...valid.repos[0], deploy: { production: "live.yml" } }] };
    expect(() => parseConfig(broken)).toThrow(/deploy.qa is required/);
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
