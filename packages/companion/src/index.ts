import { connect, type Socket } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  ControllerMessage,
  HandlerResult,
  Role,
  SessionMessage,
  SessionState,
  ToolCall,
} from "@monadeo.com/astrogate-protocol";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { rolePrompt } from "./prompts.js";

/**
 * Astrogate companion. The controller launches Pi in a herdr pane with
 * ASTROGATE_SOCKET, ASTROGATE_ROLE, and, for workers, ASTROGATE_TICKET and
 * ASTROGATE_ATTEMPT in the environment. The extension connects, registers,
 * relays state, and turns role tools into controller requests.
 */

const TOOL_TIMEOUT_MS = 5 * 60_000;

function isControllerMessage(value: unknown): value is ControllerMessage {
  return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}

function readRole(): Role | undefined {
  const role = process.env["ASTROGATE_ROLE"];
  return role === "foreman" || role === "worker" || role === "reviewer" ? role : undefined;
}

function readInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) ? value : undefined;
}

class Link {
  onDisconnect: ((ctx: ExtensionContext) => void) | undefined;
  context: ExtensionContext | undefined;
  #socket: Socket | undefined;
  #buffer = "";
  readonly #pending = new Map<string, (result: HandlerResult) => void>();
  #counter = 0;

  readonly #path: string;
  readonly #onMessage: (message: ControllerMessage) => void;

  constructor(path: string, onMessage: (message: ControllerMessage) => void) {
    this.#path = path;
    this.#onMessage = onMessage;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.#path);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        this.#socket = socket;
        resolve();
      });
      socket.once("error", reject);
      socket.on("data", (chunk: string) => this.#read(chunk));
      socket.on("close", () => {
        const wasConnected = this.#socket !== undefined;
        this.#socket = undefined;
        for (const resolvePending of this.#pending.values()) resolvePending({ ok: false, reason: "controller connection closed" });
        this.#pending.clear();
        if (wasConnected && this.context) this.onDisconnect?.(this.context);
      });
    });
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isControllerMessage(parsed)) continue;
      if (parsed.kind === "result") {
        const resolvePending = this.#pending.get(parsed.id);
        if (resolvePending) {
          this.#pending.delete(parsed.id);
          resolvePending(parsed.result);
        }
        continue;
      }
      this.#onMessage(parsed);
    }
  }

  send(message: SessionMessage): void {
    this.#socket?.write(`${JSON.stringify(message)}\n`);
  }

  call(call: ToolCall): Promise<HandlerResult> {
    const id = `${process.pid}-${++this.#counter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ ok: false, reason: "controller did not answer in time" });
      }, TOOL_TIMEOUT_MS);
      this.#pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.send({ kind: "tool", id, call });
    });
  }

  get connected(): boolean {
    return this.#socket !== undefined;
  }
}

function resultText(result: HandlerResult): string {
  return result.ok ? result.message : `Rejected: ${result.reason}`;
}

export default function astrogateCompanion(pi: ExtensionAPI): void {
  const socketPath = process.env["ASTROGATE_SOCKET"];
  const role = readRole();
  if (!socketPath || !role) return;

  const link = new Link(socketPath, (message) => {
    if (message.kind === "task") {
      const e = message.envelope;
      pi.sendUserMessage(
        [
          `Ticket #${e.ticket} in ${e.repo}, attempt ${e.attempt}. Branch ${e.branch}, worktree ${e.worktree}.`,
          `Checks that must pass before submit: ${e.checks.join(", ")}.`,
          "",
          e.brief,
        ].join("\n"),
      );
    } else if (message.kind === "message") {
      pi.sendUserMessage(message.text, { deliverAs: "steer" });
    }
  });

  let lastState: SessionState | undefined;
  const report = (state: SessionState, message?: string): void => {
    if (state === lastState) return;
    lastState = state;
    link.send({ kind: "state", state, ...(message ? { message } : {}) });
  };

  let sessionFile = "";
  const register = (): void => {
    link.send({
      kind: "register",
      registration: {
        role,
        paneId: process.env["HERDR_PANE_ID"] ?? "",
        sessionFile,
        repo: process.env["ASTROGATE_REPO"],
        ticket: readInt("ASTROGATE_TICKET"),
        attempt: readInt("ASTROGATE_ATTEMPT"),
      },
    });
    lastState = undefined;
  };
  // The controller may restart while a session lives on; keep trying until it is back.
  const connectLoop = async (ctx: ExtensionContext): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await link.open();
        register();
        ctx.ui.notify("Astrogate: connected to controller", "info");
        return;
      } catch {
        if (attempt === 0) ctx.ui.notify(`Astrogate: controller not reachable at ${socketPath}, retrying`, "warning");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  };
  link.onDisconnect = (ctx) => void connectLoop(ctx);

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    sessionFile = ctx.sessionManager.getSessionFile() ?? "";
    link.context = ctx;
    if (!link.connected) await connectLoop(ctx);
  });

  pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${rolePrompt(role)}` }));

  pi.on("agent_start", async () => report("working"));
  pi.on("agent_settled", async () => report("idle"));
  pi.on("ui_prompt_start", async () => report("blocked"));
  pi.on("ui_prompt_end", async () => report("working"));

  pi.registerCommand("takeover", {
    description: "Pause Astrogate messages to this session",
    handler: async (_args, ctx) => {
      link.send({ kind: "manual", enabled: true });
      ctx.ui.notify("Astrogate: manual mode on", "info");
    },
  });
  pi.registerCommand("release", {
    description: "Resume Astrogate messages to this session",
    handler: async (_args, ctx) => {
      link.send({ kind: "manual", enabled: false });
      ctx.ui.notify("Astrogate: manual mode off", "info");
    },
  });

  const tool = (name: string, description: string, params: Parameters<ExtensionAPI["registerTool"]>[0]["parameters"], toCall: (p: Record<string, unknown>) => ToolCall): void => {
    pi.registerTool({
      name,
      label: name,
      description,
      promptSnippet: description,
      parameters: params,
      async execute(_id, params) {
        const result = await link.call(toCall(params as Record<string, unknown>));
        return { content: [{ type: "text", text: resultText(result) }], details: {} };
      },
    });
  };

  const text = (key: string, description: string) => Type.Object({ [key]: Type.String({ description }) });

  if (role === "worker") {
    tool("submit", "Use submit when the ticket is done and all commits are made. The controller runs checks, pushes, and opens the PR.", text("summary", "What changed and why"), (p) => ({ tool: "submit", summary: String(p["summary"]) }));
    tool("ask_astro", "Use ask_astro when a decision only the owner can make blocks the work.", text("question", "The decision needed"), (p) => ({ tool: "ask_astro", question: String(p["question"]) }));
    tool("report_blocked", "Use report_blocked when an external dependency prevents progress.", text("reason", "What is missing"), (p) => ({ tool: "report_blocked", reason: String(p["reason"]) }));
  }
  if (role === "reviewer") {
    tool(
      "review_verdict",
      "Use review_verdict once, at the end of the review.",
      Type.Object({ verdict: StringEnum(["approve", "changes"] as const), notes: Type.String({ description: "Findings, one per line" }) }),
      (p) => ({ tool: "review_verdict", verdict: p["verdict"] === "approve" ? "approve" : "changes", notes: String(p["notes"]) }),
    );
  }
  if (role === "foreman") {
    tool(
      "triage_result",
      "Use triage_result once per ticket: ready with a brief, or needs_astro with one question.",
      Type.Object({ outcome: StringEnum(["ready", "needs_astro"] as const), brief: Type.Optional(Type.String()), question: Type.Optional(Type.String()) }),
      (p) =>
        p["outcome"] === "ready"
          ? { tool: "triage_result", outcome: "ready", brief: String(p["brief"] ?? "") }
          : { tool: "triage_result", outcome: "needs_astro", question: String(p["question"] ?? "") },
    );
    tool("create_ticket", "Use create_ticket to split work into a new ticket.", Type.Object({ title: Type.String(), body: Type.String() }), (p) => ({ tool: "create_ticket", title: String(p["title"]), body: String(p["body"]) }));
    tool("ask_astro", "Use ask_astro for a decision only the owner can make.", text("question", "The decision needed"), (p) => ({ tool: "ask_astro", question: String(p["question"]) }));
  }
}
