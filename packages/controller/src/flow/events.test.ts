import { describe, expect, it } from "vitest";
import { parseEvent } from "./events.js";

describe("parseEvent", () => {
  it("extracts an opened issue", () => {
    const parsed = parseEvent({
      deliveryId: "d",
      event: "issues",
      payload: { action: "opened", repository: { full_name: "o/r" }, issue: { number: 12, node_id: "I_1" }, sender: { login: "astro" } },
    });
    expect(parsed).toEqual({ kind: "issue_opened", repo: "o/r", number: 12, issueNodeId: "I_1" });
  });
  it("ignores pull request comments", () => {
    const parsed = parseEvent({
      deliveryId: "d",
      event: "issue_comment",
      payload: { action: "created", repository: { full_name: "o/r" }, issue: { number: 1, node_id: "x", pull_request: {} }, comment: { body: "hi" }, sender: { login: "a" } },
    });
    expect(parsed.kind).toBe("ignored");
  });
  it("reduces a workflow run to path, branch, and conclusion", () => {
    const parsed = parseEvent({
      deliveryId: "d",
      event: "workflow_run",
      payload: { action: "completed", repository: { full_name: "o/r" }, workflow_run: { path: ".github/workflows/qa.yml", head_branch: "astrogate/release", conclusion: "success", html_url: "u" } },
    });
    expect(parsed).toEqual({ kind: "workflow_run_completed", repo: "o/r", path: ".github/workflows/qa.yml", headBranch: "astrogate/release", conclusion: "success", htmlUrl: "u" });
  });
});
