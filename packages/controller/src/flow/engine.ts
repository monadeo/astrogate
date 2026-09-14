import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HandlerResult, Role, SessionMessage, TaskEnvelope, ToolCall } from "@monadeo.com/astrogate-protocol";
import { findRepo, type Config, type RepoConfig } from "../config.js";
import { DiscordNotifier } from "../discord/notifier.js";
import type { GitHubApp } from "../github/client.js";
import type { BoardItem, ProjectBoard } from "../github/projects.js";
import type { RepoApi } from "../github/repo.js";
import { paneClose } from "../herdr/cli.js";
import { log } from "../log.js";
import { launchInWorkspace, launchInWorktree, type LaunchTarget } from "../sessions/launcher.js";
import type { LiveSession, SessionServer } from "../sessions/socket.js";
import type { AttemptRow, StateDb } from "../state/db.js";
import type { WebhookEvent } from "../webhook/server.js";
import { runCheck } from "./check.js";
import { parseEvent } from "./events.js";
import { changedFiles, commitCount, ensureClone, headSha, isClean, push, repoDir } from "./git.js";
import { STATUS, type Status } from "./status.js";

const BRIEF_MARKER = "<!-- astrogate:brief -->";
const REVIEW_CHECK = "astrogate/review";
const RELEASE_BRANCH = "astrogate/release";
const REGISTRATION_TIMEOUT_MS = 3 * 60_000;

export interface EngineDeps {
  config: Config;
  db: StateDb;
  github: GitHubApp;
  repos: RepoApi;
  board: ProjectBoard;
  sessions: SessionServer;
  discord: DiscordNotifier;
  socketPath: string;
}

interface Pending {
  resolve: (session: LiveSession) => void;
  timer: NodeJS.Timeout;
}

function attemptKey(role: Role, repo: string, ticket: number, attempt: number): string {
  return `${role}:${repo}#${ticket}@${attempt}`;
}

function sessionKey(session: LiveSession): string | undefined {
  const r = session.registration;
  if (!r.repo || r.ticket === undefined || r.attempt === undefined) return undefined;
  return attemptKey(r.role, r.repo, r.ticket, r.attempt);
}

/** Deterministic orchestration: events and tool calls in, GitHub writes and session launches out. */
export class Engine {
  readonly #d: EngineDeps;
  readonly #pending = new Map<string, Pending>();
  readonly #intentionalStops = new Set<number>();
  readonly #defaultBranches = new Map<string, string>();

  constructor(deps: EngineDeps) {
    this.#d = deps;
  }

  // ---------- inbound: webhooks ----------

  async onEvent(event: WebhookEvent): Promise<void> {
    const parsed = parseEvent(event);
    log("event", parsed.kind, { delivery: event.deliveryId, ...(parsed.kind === "ignored" ? { reason: parsed.reason } : {}) });
    switch (parsed.kind) {
      case "issue_opened": {
        if (!this.#project(parsed.repo)) return;
        const item = (await this.#d.board.itemForIssue(parsed.issueNodeId)) ?? (await this.#addToBoard(parsed.issueNodeId));
        if (item.status === undefined) await this.#setStatus(item, STATUS.inbox);
        await this.startForeman(parsed.repo, parsed.number, "triage");
        return;
      }
      case "issue_comment": {
        if (!this.#project(parsed.repo) || parsed.sender !== this.#d.config.github.owner) return;
        const item = await this.#d.board.itemForIssue(parsed.issueNodeId);
        if (!item) return;
        if (item.status === STATUS.needsAstro) await this.#onAnswer(item, parsed.body);
        else if (item.status === STATUS.readyForAcceptance && parsed.body.trim().startsWith("/reject")) await this.#onReject(item, parsed.body);
        return;
      }
      case "board_item": {
        const item = await this.#d.board.itemForIssue(parsed.issueNodeId);
        if (!item || !this.#project(item.repo)) return;
        if (item.status === STATUS.inbox) await this.startForeman(item.repo, item.number, "triage");
        else if (item.status === STATUS.ready) await this.fillSlots();
        else if (item.status === STATUS.done && parsed.sender === this.#d.config.github.owner) await this.#onAccepted(item);
        return;
      }
      case "check_suite_completed": {
        const attempt = this.#d.db.attemptByHeadSha(parsed.repo, parsed.headSha);
        if (attempt) await this.#tryMerge(attempt);
        return;
      }
      case "workflow_run_completed": {
        const project = this.#project(parsed.repo);
        if (!project) return;
        const file = parsed.path.split("/").pop() ?? "";
        if (project.deploy.qa && file === project.deploy.qa) await this.#onQaResult(project, parsed.conclusion, parsed.htmlUrl);
        else if (file === project.deploy.production) await this.#onProductionResult(project, parsed.conclusion, parsed.htmlUrl);
        return;
      }
      case "ignored":
        return;
    }
  }

  // ---------- inbound: sessions ----------

  onRegister(session: LiveSession): void {
    const key = sessionKey(session);
    log("session", "registered", { ...session.registration });
    if (!key) return;
    const pending = this.#pending.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(key);
      pending.resolve(session);
      return;
    }
    // A session that reconnected after a controller restart: refresh what we know.
    const r = session.registration;
    const row = this.#d.db.findAttempt(r.repo ?? "", r.ticket ?? 0, r.attempt ?? 0, r.role);
    if (row && r.sessionFile) this.#d.db.setSessionFile(row.id, r.sessionFile);
  }

  async onMessage(session: LiveSession, message: SessionMessage): Promise<void> {
    if (message.kind !== "tool") {
      if (message.kind === "state") log("session", `state ${message.state}`, { ...session.registration });
      return;
    }
    let result: HandlerResult;
    try {
      result = await this.#onTool(session, message.call);
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      log("tool", `failed: ${result.reason}`, { ...session.registration, tool: message.call.tool });
    }
    session.send({ kind: "result", id: message.id, result });
  }

  async onClose(session: LiveSession): Promise<void> {
    const r = session.registration;
    const row = this.#d.db.findAttempt(r.repo ?? "", r.ticket ?? 0, r.attempt ?? 0, r.role);
    if (!row || row.status !== "running") return;
    if (this.#intentionalStops.delete(row.id)) return;
    log("session", "closed unexpectedly", { ...r });
    this.#d.db.stopAttempt(row.id);
    if (r.role !== "worker" || !r.repo || r.ticket === undefined) return;
    const item = await this.#itemByNumber(r.repo, r.ticket);
    if (item?.status === STATUS.inProgress) await this.startWorker(item, "The previous session ended unexpectedly. Continue from the current state of the worktree.");
  }

  // ---------- scheduling ----------

  async fillSlots(): Promise<void> {
    const running = this.#d.db.runningAttempts().filter((a) => a.role === "worker");
    let free = this.#d.config.concurrency.workers - running.length;
    if (free <= 0) return;
    const ready = await this.#d.board.itemsWithStatus(STATUS.ready);
    for (const item of ready) {
      if (free <= 0) break;
      if (!this.#project(item.repo) || running.some((a) => a.repo === item.repo && a.ticket === item.number)) continue;
      await this.startWorker(item);
      free -= 1;
    }
  }

  async tick(): Promise<void> {
    await this.fillSlots();
    const windowMs = this.#d.config.reminders.afterMinutes * 60_000;
    for (const status of [STATUS.needsAstro, STATUS.readyForAcceptance] as Status[]) {
      for (const item of await this.#d.board.itemsWithStatus(status)) {
        if (this.#d.db.shouldAlert(`reminder:${item.repo}#${item.number}`, windowMs)) {
          await this.#alert(`Reminder: ${item.repo}#${item.number} is still in ${status}. ${this.#issueUrl(item)} · ${this.#d.board.url}`);
        }
      }
    }
  }

  /** After a controller restart: drop rows whose panes are gone, relaunch workers that were mid-ticket. */
  async recover(): Promise<void> {
    for (const row of this.#d.db.runningAttempts()) {
      const alive = this.#d.sessions.find((r) => r.repo === row.repo && r.ticket === row.ticket && r.attempt === row.attempt && r.role === row.role);
      if (alive) continue;
      this.#d.db.stopAttempt(row.id);
      if (row.role !== "worker") continue;
      const item = await this.#itemByNumber(row.repo, row.ticket);
      if (item?.status === STATUS.inProgress) await this.startWorker(item, "The controller restarted. Continue from the current state of the worktree.");
    }
    await this.fillSlots();
  }

  // ---------- launching ----------

  async startForeman(repo: string, ticket: number, purpose: "triage" | "answer" | "rework", extra = ""): Promise<void> {
    const project = this.#project(repo);
    if (!project || this.#d.db.runningAttempt(repo, ticket, "foreman")) return;
    const cwd = await this.#clone(project);
    const previous = this.#d.db.latestAttempt(repo, ticket, "foreman");
    const attempt = (previous?.attempt ?? 0) + 1;
    const target: LaunchTarget = { role: "foreman", repo, ticket, attempt, cwd };
    const launched = await launchInWorkspace(this.#d.config, this.#d.socketPath, target, `foreman #${ticket}`);
    const row = this.#d.db.insertAttempt({ repo, ticket, attempt, role: "foreman", branch: "", worktree: cwd, workspaceId: launched.workspaceId, paneId: launched.paneId });
    const session = await this.#awaitRegistration(row);
    const issue = await this.#d.repos.issue(repo, ticket);
    const comments = await this.#d.repos.comments(repo, ticket);
    const brief = [
      purpose === "triage"
        ? "Triage this ticket. Decide whether a worker can start: call triage_result with outcome ready and a brief, or outcome needs_astro with one question."
        : purpose === "answer"
          ? `The owner answered the open question. Re-triage with that answer:\n${extra}`
          : `The owner rejected the result with this feedback. Write a brief for the rework:\n${extra}`,
      "",
      `# ${issue.title}`,
      issue.body,
      ...comments.slice(-20).map((c) => `\n--- comment by ${c.user} at ${c.createdAt} ---\n${c.body}`),
    ].join("\n");
    session.send({ kind: "task", envelope: this.#envelope(project, ticket, attempt, "", cwd, brief) });
  }

  async startWorker(item: BoardItem, preface = ""): Promise<void> {
    const project = this.#project(item.repo);
    if (!project || this.#d.db.runningAttempt(item.repo, item.number, "worker")) return;
    const previous = this.#d.db.latestAttempt(item.repo, item.number, "worker");
    const attempt = (previous?.attempt ?? 0) + 1;
    if (attempt > this.#d.config.attemptCap) {
      await this.#escalate(item, `Attempt cap (${this.#d.config.attemptCap}) reached.`);
      return;
    }
    const clone = await this.#clone(project);
    const defaultBranch = await this.#defaultBranch(project);
    const branch = `astrogate/${item.number}`;
    const worktree = join(this.#d.config.worker.worktreesDir, item.repo, String(item.number));
    const existing = existsSync(join(worktree, ".git"));
    const target: LaunchTarget = { role: "worker", repo: item.repo, ticket: item.number, attempt, cwd: worktree, ...(existing && previous?.sessionFile ? { sessionFile: previous.sessionFile } : {}) };
    const launched = await launchInWorktree(this.#d.config, this.#d.socketPath, target, clone, branch, `origin/${defaultBranch}`, existing);
    const row = this.#d.db.insertAttempt({ repo: item.repo, ticket: item.number, attempt, role: "worker", branch, worktree, workspaceId: launched.workspaceId, paneId: launched.paneId });
    const session = await this.#awaitRegistration(row);
    await this.#setStatus(item, STATUS.inProgress);
    const issue = await this.#d.repos.issue(item.repo, item.number);
    const comments = await this.#d.repos.comments(item.repo, item.number);
    const briefComment = [...comments].reverse().find((c) => c.body.startsWith(BRIEF_MARKER));
    const brief = [
      preface,
      `# ${issue.title}`,
      issue.body,
      briefComment ? `\n## Brief from the foreman\n${briefComment.body.replace(BRIEF_MARKER, "").trim()}` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n");
    session.send({ kind: "task", envelope: this.#envelope(project, item.number, attempt, branch, worktree, brief) });
  }

  async #startReviewer(worker: AttemptRow, prNumber: number, prUrl: string): Promise<void> {
    const project = this.#project(worker.repo);
    if (!project || this.#d.db.runningAttempt(worker.repo, worker.ticket, "reviewer")) return;
    const previous = this.#d.db.latestAttempt(worker.repo, worker.ticket, "reviewer");
    const attempt = (previous?.attempt ?? 0) + 1;
    const target: LaunchTarget = { role: "reviewer", repo: worker.repo, ticket: worker.ticket, attempt, cwd: worker.worktree };
    const launched = await launchInWorkspace(this.#d.config, this.#d.socketPath, target, `review #${worker.ticket}`);
    const row = this.#d.db.insertAttempt({ repo: worker.repo, ticket: worker.ticket, attempt, role: "reviewer", branch: worker.branch, worktree: worker.worktree, workspaceId: launched.workspaceId, paneId: launched.paneId });
    const session = await this.#awaitRegistration(row);
    const defaultBranch = await this.#defaultBranch(project);
    const brief = [
      `Review pull request #${prNumber} (${prUrl}) for ticket #${worker.ticket}.`,
      `You are in the worker's worktree on branch ${worker.branch}. Read only; never edit or commit here.`,
      `The diff under review is: git diff origin/${defaultBranch}...HEAD`,
      `Finish with exactly one review_verdict call.`,
    ].join("\n");
    session.send({ kind: "task", envelope: this.#envelope(project, worker.ticket, attempt, worker.branch, worker.worktree, brief) });
  }

  #envelope(project: RepoConfig, ticket: number, attempt: number, branch: string, worktree: string, brief: string): TaskEnvelope {
    return { ticket, attempt, repo: project.repo, branch, worktree, brief, checks: [project.checkScript] };
  }

  #awaitRegistration(row: AttemptRow): Promise<LiveSession> {
    const key = attemptKey(row.role, row.repo, row.ticket, row.attempt);
    const already = this.#d.sessions.find((r) => sessionKey({ registration: r, manual: false, send: () => undefined }) === key);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        this.#d.db.stopAttempt(row.id);
        reject(new Error(`session ${key} did not register within ${REGISTRATION_TIMEOUT_MS / 1000}s`));
      }, REGISTRATION_TIMEOUT_MS);
      this.#pending.set(key, {
        resolve: (session) => {
          if (session.registration.sessionFile) this.#d.db.setSessionFile(row.id, session.registration.sessionFile);
          resolve(session);
        },
        timer,
      });
    });
  }

  async #stop(row: AttemptRow): Promise<void> {
    this.#intentionalStops.add(row.id);
    this.#d.db.stopAttempt(row.id);
    try {
      await paneClose(row.paneId);
    } catch (error) {
      log("herdr", `pane close failed: ${error instanceof Error ? error.message : String(error)}`, { pane: row.paneId });
    }
  }

  // ---------- tools ----------

  async #onTool(session: LiveSession, call: ToolCall): Promise<HandlerResult> {
    const r = session.registration;
    if (!r.repo || r.ticket === undefined || r.attempt === undefined) return { ok: false, reason: "session is not bound to a ticket" };
    const row = this.#d.db.findAttempt(r.repo, r.ticket, r.attempt, r.role);
    if (!row) return { ok: false, reason: "unknown attempt" };
    const item = await this.#itemByNumber(r.repo, r.ticket);
    if (!item) return { ok: false, reason: "ticket is not on the board" };
    const allowed: Record<Role, ToolCall["tool"][]> = {
      worker: ["submit", "ask_astro", "report_blocked"],
      reviewer: ["review_verdict"],
      foreman: ["triage_result", "create_ticket", "ask_astro"],
    };
    if (!allowed[r.role].includes(call.tool)) return { ok: false, reason: `${call.tool} is not available to the ${r.role}` };
    log("tool", call.tool, { ...r });
    switch (call.tool) {
      case "submit":
        return this.#submit(row, item, call.summary);
      case "ask_astro":
        await this.#d.repos.comment(item.repo, item.number, `**Question from the ${r.role}:**\n\n${call.question}`);
        await this.#setStatus(item, STATUS.needsAstro);
        await this.#alert(`Decision needed on ${item.repo}#${item.number}: ${call.question.slice(0, 300)}\n${this.#issueUrl(item)} · ${this.#d.board.url}`);
        if (r.role === "foreman") await this.#stop(row);
        return { ok: true, message: "Question posted. The answer arrives here as a new message; wait for it." };
      case "report_blocked":
        await this.#d.repos.comment(item.repo, item.number, `**Blocked:** ${call.reason}`);
        await this.#setStatus(item, STATUS.blocked);
        await this.#alert(`${item.repo}#${item.number} is blocked: ${call.reason.slice(0, 300)}\n${this.#issueUrl(item)}`);
        await this.#stop(row);
        return { ok: true, message: "Recorded as blocked. This session stops now." };
      case "review_verdict":
        return this.#reviewVerdict(row, item, call.verdict, call.notes);
      case "triage_result":
        if (call.outcome === "ready") {
          await this.#d.repos.comment(item.repo, item.number, `${BRIEF_MARKER}\n${call.brief}`);
          await this.#setStatus(item, STATUS.ready);
          await this.#stop(row);
          void this.fillSlots();
          return { ok: true, message: "Brief posted, ticket is Ready. This session stops now." };
        }
        await this.#d.repos.comment(item.repo, item.number, `**Question from the foreman:**\n\n${call.question}`);
        await this.#setStatus(item, STATUS.needsAstro);
        await this.#alert(`Decision needed on ${item.repo}#${item.number}: ${call.question.slice(0, 300)}\n${this.#issueUrl(item)} · ${this.#d.board.url}`);
        await this.#stop(row);
        return { ok: true, message: "Question posted, ticket is in Needs Astro. This session stops now." };
      case "create_ticket": {
        const issue = await this.#d.repos.createIssue(item.repo, call.title, `${call.body}\n\nSplit from #${item.number}.`);
        return { ok: true, message: `Created #${issue.number}: ${issue.htmlUrl}` };
      }
    }
  }

  async #submit(row: AttemptRow, item: BoardItem, summary: string): Promise<HandlerResult> {
    const project = this.#project(item.repo);
    if (!project) return { ok: false, reason: "project not configured" };
    const defaultBranch = await this.#defaultBranch(project);
    const base = `origin/${defaultBranch}`;
    const wt = row.worktree;
    if (!(await isClean(wt))) return { ok: false, reason: "The worktree has uncommitted changes. Commit everything, then call submit again." };
    if ((await commitCount(wt, base)) === 0) return { ok: false, reason: `No commits on top of ${base}.` };
    const files = await changedFiles(wt, base);
    const workflowFiles = files.filter((f) => f.startsWith(".github/workflows/"));
    if (workflowFiles.length > 0) return { ok: false, reason: `Changes under .github/workflows are not allowed: ${workflowFiles.join(", ")}. Revert them.` };
    const check = await runCheck(wt, project.checkScript);
    if (!check.ok) return { ok: false, reason: `Check script failed. Fix and submit again.\n\n${check.output.slice(-6000)}` };
    const token = await this.#d.github.installationToken({ repositories: [item.repo.split("/")[1] ?? ""], permissions: { contents: "write" } });
    await push(wt, row.branch, token);
    const sha = await headSha(wt);
    const prBase = project.tier === "critical" ? await this.#ensureReleaseBranch(project, defaultBranch) : defaultBranch;
    const existing = await this.#d.repos.openPulls(item.repo, row.branch);
    const issue = await this.#d.repos.issue(item.repo, item.number);
    const pr = existing[0] ?? (await this.#d.repos.createPull(item.repo, issue.title, `Ticket #${item.number}\n\n${summary}`, row.branch, prBase));
    this.#d.db.setPr(row.id, pr.number, sha);
    await this.#setStatus(item, STATUS.review);
    await this.#startReviewer(row, pr.number, pr.htmlUrl);
    return { ok: true, message: `Pushed and opened PR #${pr.number}. The ticket is in Review. Stop and wait; review feedback arrives here as a message.` };
  }

  async #reviewVerdict(reviewer: AttemptRow, item: BoardItem, verdict: "approve" | "changes", notes: string): Promise<HandlerResult> {
    const worker = this.#d.db.latestAttempt(item.repo, item.number, "worker");
    if (!worker || worker.pr === null || worker.headSha === null) return { ok: false, reason: "no pull request on record for this ticket" };
    await this.#d.repos.createCheckRun(item.repo, worker.headSha, REVIEW_CHECK, verdict === "approve", verdict === "approve" ? "Approved" : "Changes requested", notes);
    this.#d.db.setReview(worker.id, verdict === "approve" ? "approved" : "changes");
    await this.#stop(reviewer);
    if (verdict === "approve") {
      await this.#tryMerge(worker);
      return { ok: true, message: "Approval recorded. This session stops now." };
    }
    await this.#d.repos.comment(item.repo, item.number, `**Review: changes requested**\n\n${notes}`);
    await this.#setStatus(item, STATUS.inProgress);
    await this.#sendToWorker(item, worker, `Review requested changes:\n\n${notes}\n\nAddress them, commit, and call submit again.`);
    return { ok: true, message: "Changes requested; the worker has the notes. This session stops now." };
  }

  // ---------- merge and deploy ----------

  async #tryMerge(worker: AttemptRow): Promise<void> {
    const item = await this.#itemByNumber(worker.repo, worker.ticket);
    const project = this.#project(worker.repo);
    if (!item || !project || worker.review !== "approved" || worker.pr === null || worker.headSha === null) return;
    const runs = (await this.#d.repos.checkRuns(worker.repo, worker.headSha)).filter((r) => r.name !== REVIEW_CHECK);
    if (runs.some((r) => r.status !== "completed")) return;
    const failed = runs.filter((r) => !["success", "neutral", "skipped"].includes(r.conclusion ?? ""));
    if (failed.length > 0) {
      await this.#setStatus(item, STATUS.inProgress);
      await this.#sendToWorker(item, worker, `CI failed on the pull request: ${failed.map((r) => r.name).join(", ")}. Fix, commit, and call submit again.`);
      return;
    }
    const pr = await this.#d.repos.pull(worker.repo, worker.pr);
    if (pr.merged) return;
    await this.#d.repos.mergePull(worker.repo, worker.pr, worker.headSha);
    await this.#stop(worker);
    const defaultBranch = await this.#defaultBranch(project);
    if (project.tier === "critical" && project.deploy.qa) {
      this.#d.db.setMember(worker.repo, worker.ticket, "qa");
      await this.#setStatus(item, STATUS.qa);
      await this.#d.repos.dispatchWorkflow(worker.repo, project.deploy.qa, RELEASE_BRANCH);
    } else {
      this.#d.db.setMember(worker.repo, worker.ticket, "prod");
      await this.#d.repos.dispatchWorkflow(worker.repo, project.deploy.production, defaultBranch);
    }
  }

  async #onQaResult(project: RepoConfig, conclusion: string, url: string): Promise<void> {
    const members = this.#d.db.members(project.repo).filter((m) => m.state === "qa");
    if (members.length === 0) return;
    const list = members.map((m) => `#${m.ticket}`).join(", ");
    if (conclusion === "success") {
      for (const m of members) {
        const item = await this.#itemByNumber(project.repo, m.ticket);
        if (item) await this.#setStatus(item, STATUS.readyForAcceptance);
      }
      await this.#alert(`Release of ${project.repo} is on QA, awaiting your acceptance: ${list}\n${project.deploy.qaUrl ?? url} · ${this.#d.board.url}`);
      return;
    }
    for (const m of members) {
      const item = await this.#itemByNumber(project.repo, m.ticket);
      if (item) await this.#setStatus(item, STATUS.needsAstro);
    }
    await this.#alert(`QA deploy of ${project.repo} failed (${conclusion}): ${list}\n${url}`);
  }

  async #onProductionResult(project: RepoConfig, conclusion: string, url: string): Promise<void> {
    const members = this.#d.db.members(project.repo);
    const shipping = members.filter((m) => m.state === "shipping");
    const direct = members.filter((m) => m.state === "prod");
    if (conclusion === "success") {
      for (const m of shipping) this.#d.db.removeMember(project.repo, m.ticket);
      if (shipping.length > 0) {
        await this.#alert(`${project.repo} release shipped to production: ${shipping.map((m) => `#${m.ticket}`).join(", ")}\n${url}`);
        if (await this.#d.repos.branchExists(project.repo, RELEASE_BRANCH)) await this.#d.repos.deleteBranch(project.repo, RELEASE_BRANCH);
      }
      for (const m of direct) {
        const item = await this.#itemByNumber(project.repo, m.ticket);
        if (item) await this.#setStatus(item, STATUS.readyForAcceptance);
        this.#d.db.removeMember(project.repo, m.ticket);
      }
      if (direct.length > 0) {
        await this.#alert(`${project.repo} deployed to production, awaiting your acceptance: ${direct.map((m) => `#${m.ticket}`).join(", ")}\n${url} · ${this.#d.board.url}`);
      }
      return;
    }
    const affected = [...shipping, ...direct];
    for (const m of affected) {
      const item = await this.#itemByNumber(project.repo, m.ticket);
      if (item) await this.#setStatus(item, STATUS.needsAstro);
    }
    await this.#alert(`Production deploy of ${project.repo} failed (${conclusion}): ${affected.map((m) => `#${m.ticket}`).join(", ")}\n${url}`);
  }

  async #onAccepted(item: BoardItem): Promise<void> {
    const project = this.#project(item.repo);
    const member = this.#d.db.member(item.repo, item.number);
    if (!project || !member) return;
    this.#d.db.clearAlert(`reminder:${item.repo}#${item.number}`);
    if (project.tier !== "critical") {
      this.#d.db.removeMember(item.repo, item.number);
      return;
    }
    this.#d.db.setMember(item.repo, item.number, "accepted");
    const members = this.#d.db.members(item.repo);
    if (members.some((m) => m.state === "qa" || m.state === "shipping")) return;
    const defaultBranch = await this.#defaultBranch(project);
    await this.#d.repos.mergeBranches(item.repo, defaultBranch, RELEASE_BRANCH, `Release: ${members.map((m) => `#${m.ticket}`).join(", ")}`);
    for (const m of members) this.#d.db.setMember(item.repo, m.ticket, "shipping");
    await this.#d.repos.dispatchWorkflow(item.repo, project.deploy.production, defaultBranch);
  }

  async #onAnswer(item: BoardItem, body: string): Promise<void> {
    this.#d.db.clearAlert(`reminder:${item.repo}#${item.number}`);
    const worker = this.#d.db.runningAttempt(item.repo, item.number, "worker");
    if (worker) {
      await this.#setStatus(item, STATUS.inProgress);
      await this.#sendToWorker(item, worker, `Answer from the owner:\n\n${body}`);
      return;
    }
    await this.startForeman(item.repo, item.number, "answer", body);
  }

  async #onReject(item: BoardItem, body: string): Promise<void> {
    this.#d.db.removeMember(item.repo, item.number);
    await this.#setStatus(item, STATUS.inProgress);
    const worker = this.#d.db.latestAttempt(item.repo, item.number, "worker");
    const feedback = body.trim().replace(/^\/reject\s*/, "");
    if (worker) await this.#sendToWorker(item, worker, `The owner rejected the result:\n\n${feedback}\n\nRework, commit, and call submit again.`);
    else await this.startForeman(item.repo, item.number, "rework", feedback);
  }

  async #sendToWorker(item: BoardItem, worker: AttemptRow, text: string): Promise<void> {
    const live = this.#d.sessions.find((r) => r.role === "worker" && r.repo === item.repo && r.ticket === item.number);
    if (live && worker.status === "running") {
      if (!live.manual) live.send({ kind: "message", text });
      return;
    }
    await this.startWorker(item, text);
  }

  async #ensureReleaseBranch(project: RepoConfig, defaultBranch: string): Promise<string> {
    if (!(await this.#d.repos.branchExists(project.repo, RELEASE_BRANCH))) {
      await this.#d.repos.createBranch(project.repo, RELEASE_BRANCH, await this.#d.repos.branchSha(project.repo, defaultBranch));
    }
    return RELEASE_BRANCH;
  }

  // ---------- helpers ----------

  #project(repo: string): RepoConfig | undefined {
    return findRepo(this.#d.config, repo);
  }

  async #clone(project: RepoConfig): Promise<string> {
    const token = await this.#d.github.installationToken({ repositories: [project.repo.split("/")[1] ?? ""], permissions: { contents: "read" } });
    return ensureClone(this.#d.config.worker.reposDir, project.repo, await this.#defaultBranch(project), token);
  }

  async #defaultBranch(project: RepoConfig): Promise<string> {
    const cached = this.#defaultBranches.get(project.repo);
    if (cached) return cached;
    const branch = await this.#d.repos.defaultBranch(project.repo);
    this.#defaultBranches.set(project.repo, branch);
    return branch;
  }

  async #addToBoard(issueNodeId: string): Promise<BoardItem> {
    await this.#d.board.addIssue(issueNodeId);
    const item = await this.#d.board.itemForIssue(issueNodeId);
    if (!item) throw new Error("issue not on board after adding it");
    return item;
  }

  async #itemByNumber(repo: string, number: number): Promise<BoardItem | undefined> {
    const issue = await this.#d.repos.issue(repo, number);
    return this.#d.board.itemForIssue(issue.nodeId);
  }

  async #setStatus(item: BoardItem, status: Status): Promise<void> {
    if (item.status === status) return;
    await this.#d.board.setStatus(item.itemId, status);
    item.status = status;
    log("board", `${item.repo}#${item.number} -> ${status}`);
  }

  async #escalate(item: BoardItem, reason: string): Promise<void> {
    await this.#d.repos.comment(item.repo, item.number, `**Astrogate stopped:** ${reason}`);
    await this.#setStatus(item, STATUS.needsAstro);
    await this.#alert(`${item.repo}#${item.number} needs you: ${reason}\n${this.#issueUrl(item)} · ${this.#d.board.url}`);
  }

  #issueUrl(item: BoardItem): string {
    return `https://github.com/${item.repo}/issues/${item.number}`;
  }

  async #alert(text: string): Promise<void> {
    log("alert", text.split("\n")[0] ?? "");
    await this.#d.discord.post(text);
  }
}

export { repoDir };
