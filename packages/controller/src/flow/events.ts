import type { WebhookEvent } from "../webhook/server.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(obj: unknown, key: string): string | undefined {
  return isRecord(obj) && typeof obj[key] === "string" ? (obj[key] as string) : undefined;
}

function int(obj: unknown, key: string): number | undefined {
  return isRecord(obj) && typeof obj[key] === "number" ? (obj[key] as number) : undefined;
}

function rec(obj: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(obj) && isRecord(obj[key]) ? (obj[key] as Record<string, unknown>) : undefined;
}

export type ParsedEvent =
  | { kind: "issue_opened"; repo: string; number: number; issueNodeId: string }
  | { kind: "issue_comment"; repo: string; number: number; issueNodeId: string; sender: string; body: string }
  | { kind: "board_item"; action: string; issueNodeId: string; sender: string }
  | { kind: "check_suite_completed"; repo: string; headSha: string }
  | { kind: "workflow_run_completed"; repo: string; path: string; headBranch: string; conclusion: string; htmlUrl: string }
  | { kind: "ignored"; reason: string };

/** Reduces a webhook payload to the fields the engine acts on; everything else is re-read from the API. */
export function parseEvent(event: WebhookEvent): ParsedEvent {
  const p = event.payload;
  const action = str(p, "action") ?? "";
  const repo = str(rec(p, "repository"), "full_name");
  const sender = str(rec(p, "sender"), "login") ?? "";
  switch (event.event) {
    case "issues": {
      const issue = rec(p, "issue");
      const number = int(issue, "number");
      const nodeId = str(issue, "node_id");
      if ((action === "opened" || action === "reopened") && repo && number !== undefined && nodeId && !str(issue, "pull_request")) {
        return { kind: "issue_opened", repo, number, issueNodeId: nodeId };
      }
      return { kind: "ignored", reason: `issues.${action}` };
    }
    case "issue_comment": {
      const issue = rec(p, "issue");
      const number = int(issue, "number");
      const nodeId = str(issue, "node_id");
      const body = str(rec(p, "comment"), "body");
      if (action === "created" && repo && number !== undefined && nodeId && body !== undefined && !rec(issue, "pull_request")) {
        return { kind: "issue_comment", repo, number, issueNodeId: nodeId, sender, body };
      }
      return { kind: "ignored", reason: `issue_comment.${action}` };
    }
    case "projects_v2_item": {
      const item = rec(p, "projects_v2_item");
      const contentType = str(item, "content_type");
      const nodeId = str(item, "content_node_id");
      if (contentType === "Issue" && nodeId && (action === "created" || action === "edited" || action === "restored")) {
        return { kind: "board_item", action, issueNodeId: nodeId, sender };
      }
      return { kind: "ignored", reason: `projects_v2_item.${action}` };
    }
    case "check_suite": {
      const sha = str(rec(p, "check_suite"), "head_sha");
      if (action === "completed" && repo && sha) return { kind: "check_suite_completed", repo, headSha: sha };
      return { kind: "ignored", reason: `check_suite.${action}` };
    }
    case "workflow_run": {
      const run = rec(p, "workflow_run");
      const path = str(run, "path");
      const headBranch = str(run, "head_branch");
      const conclusion = str(run, "conclusion");
      const htmlUrl = str(run, "html_url") ?? "";
      if (action === "completed" && repo && path && headBranch && conclusion) {
        return { kind: "workflow_run_completed", repo, path, headBranch, conclusion, htmlUrl };
      }
      return { kind: "ignored", reason: `workflow_run.${action}` };
    }
    default:
      return { kind: "ignored", reason: event.event };
  }
}
