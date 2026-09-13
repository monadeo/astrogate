/**
 * Wire protocol between the Astrogate controller and the Pi companion extension.
 * One Unix socket per Cortex; one connection per Pi session.
 */

export type Role = "foreman" | "worker" | "reviewer";

export type SessionState = "working" | "idle" | "blocked";

export interface SessionRegistration {
  role: Role;
  paneId: string;
  sessionFile: string;
  ticket?: number;
  attempt?: number;
}

export interface TaskEnvelope {
  ticket: number;
  attempt: number;
  repo: string;
  branch: string;
  worktree: string;
  brief: string;
  checks: string[];
}

export type ToolCall =
  | { tool: "submit"; summary: string }
  | { tool: "ask_astro"; question: string }
  | { tool: "report_blocked"; reason: string }
  | { tool: "review_verdict"; verdict: "approve" | "changes"; notes: string }
  | { tool: "triage_result"; outcome: "ready"; brief: string }
  | { tool: "triage_result"; outcome: "needs_astro"; question: string }
  | { tool: "create_ticket"; title: string; body: string };

export type HandlerResult = { ok: true; message: string } | { ok: false; reason: string };

/** Messages the session sends to the controller. */
export type SessionMessage =
  | { kind: "register"; registration: SessionRegistration }
  | { kind: "state"; state: SessionState; message?: string }
  | { kind: "tool"; id: string; call: ToolCall }
  | { kind: "manual"; enabled: boolean };

/** Messages the controller sends to the session. */
export type ControllerMessage =
  | { kind: "task"; envelope: TaskEnvelope }
  | { kind: "message"; text: string }
  | { kind: "result"; id: string; result: HandlerResult }
  | { kind: "stop" };
