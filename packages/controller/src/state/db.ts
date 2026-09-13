import { DatabaseSync } from "node:sqlite";
import type { Role } from "@monadeo.com/astrogate-protocol";

export interface AttemptRow {
  id: number;
  repo: string;
  ticket: number;
  attempt: number;
  role: Role;
  branch: string;
  worktree: string;
  workspaceId: string;
  paneId: string;
  sessionFile: string | null;
  pr: number | null;
  headSha: string | null;
  review: "approved" | "changes" | null;
  status: "running" | "stopped";
  createdAt: string;
}

export type MemberState = "qa" | "prod" | "accepted" | "shipping";

export interface MemberRow {
  repo: string;
  ticket: number;
  state: MemberState;
}

const SCHEMA = `
create table if not exists deliveries (
  id text primary key,
  event text not null,
  received_at text not null
);
create table if not exists attempts (
  id integer primary key autoincrement,
  repo text not null,
  ticket integer not null,
  attempt integer not null,
  role text not null,
  branch text not null,
  worktree text not null,
  workspace_id text not null,
  pane_id text not null,
  session_file text,
  pr integer,
  head_sha text,
  review text,
  status text not null default 'running',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (repo, ticket, attempt, role)
);
create table if not exists release_members (
  repo text not null,
  ticket integer not null,
  state text not null,
  primary key (repo, ticket)
);
create table if not exists alerts (
  key text primary key,
  sent_at text not null
);
`;

function toAttempt(row: Record<string, unknown>): AttemptRow {
  return {
    id: Number(row["id"]),
    repo: String(row["repo"]),
    ticket: Number(row["ticket"]),
    attempt: Number(row["attempt"]),
    role: String(row["role"]) as Role,
    branch: String(row["branch"]),
    worktree: String(row["worktree"]),
    workspaceId: String(row["workspace_id"]),
    paneId: String(row["pane_id"]),
    sessionFile: row["session_file"] === null ? null : String(row["session_file"]),
    pr: row["pr"] === null ? null : Number(row["pr"]),
    headSha: row["head_sha"] === null ? null : String(row["head_sha"]),
    review: row["review"] === null ? null : (String(row["review"]) as AttemptRow["review"]),
    status: String(row["status"]) as AttemptRow["status"],
    createdAt: String(row["created_at"]),
  };
}

export class StateDb {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    this.#db = new DatabaseSync(file);
    this.#db.exec("pragma journal_mode = wal");
    this.#db.exec(SCHEMA);
  }

  /** Records a delivery id. Returns false when it was already seen. */
  recordDelivery(id: string, event: string): boolean {
    const result = this.#db
      .prepare("insert or ignore into deliveries (id, event, received_at) values (?, ?, ?)")
      .run(id, event, new Date().toISOString());
    return result.changes === 1;
  }

  insertAttempt(row: Omit<AttemptRow, "id" | "status" | "createdAt" | "sessionFile" | "pr" | "headSha" | "review">): AttemptRow {
    const result = this.#db
      .prepare(
        `insert into attempts (repo, ticket, attempt, role, branch, worktree, workspace_id, pane_id)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.repo, row.ticket, row.attempt, row.role, row.branch, row.worktree, row.workspaceId, row.paneId);
    const inserted = this.getAttemptById(Number(result.lastInsertRowid));
    if (!inserted) throw new Error("attempt row vanished after insert");
    return inserted;
  }

  getAttemptById(id: number): AttemptRow | undefined {
    const row = this.#db.prepare("select * from attempts where id = ?").get(id);
    return row ? toAttempt(row) : undefined;
  }

  latestAttempt(repo: string, ticket: number, role: Role): AttemptRow | undefined {
    const row = this.#db
      .prepare("select * from attempts where repo = ? and ticket = ? and role = ? order by attempt desc limit 1")
      .get(repo, ticket, role);
    return row ? toAttempt(row) : undefined;
  }

  runningAttempts(): AttemptRow[] {
    return this.#db
      .prepare("select * from attempts where status = 'running' order by created_at")
      .all()
      .map(toAttempt);
  }

  setSessionFile(id: number, sessionFile: string): void {
    this.#db.prepare("update attempts set session_file = ? where id = ?").run(sessionFile, id);
  }

  setPr(id: number, pr: number, headSha: string): void {
    this.#db.prepare("update attempts set pr = ?, head_sha = ?, review = null where id = ?").run(pr, headSha, id);
  }

  setReview(id: number, review: "approved" | "changes"): void {
    this.#db.prepare("update attempts set review = ? where id = ?").run(review, id);
  }

  findAttempt(repo: string, ticket: number, attempt: number, role: Role): AttemptRow | undefined {
    const row = this.#db
      .prepare("select * from attempts where repo = ? and ticket = ? and attempt = ? and role = ?")
      .get(repo, ticket, attempt, role);
    return row ? toAttempt(row) : undefined;
  }

  attemptByHeadSha(repo: string, sha: string): AttemptRow | undefined {
    const row = this.#db.prepare("select * from attempts where repo = ? and head_sha = ? order by attempt desc limit 1").get(repo, sha);
    return row ? toAttempt(row) : undefined;
  }

  runningAttempt(repo: string, ticket: number, role: Role): AttemptRow | undefined {
    const row = this.#db
      .prepare("select * from attempts where repo = ? and ticket = ? and role = ? and status = 'running' order by attempt desc limit 1")
      .get(repo, ticket, role);
    return row ? toAttempt(row) : undefined;
  }

  setMember(repo: string, ticket: number, state: MemberState): void {
    this.#db
      .prepare("insert into release_members (repo, ticket, state) values (?, ?, ?) on conflict (repo, ticket) do update set state = excluded.state")
      .run(repo, ticket, state);
  }

  members(repo: string): MemberRow[] {
    return this.#db
      .prepare("select repo, ticket, state from release_members where repo = ? order by ticket")
      .all(repo)
      .map((row) => ({ repo: String(row["repo"]), ticket: Number(row["ticket"]), state: String(row["state"]) as MemberState }));
  }

  member(repo: string, ticket: number): MemberRow | undefined {
    const row = this.#db.prepare("select repo, ticket, state from release_members where repo = ? and ticket = ?").get(repo, ticket);
    return row ? { repo: String(row["repo"]), ticket: Number(row["ticket"]), state: String(row["state"]) as MemberState } : undefined;
  }

  removeMember(repo: string, ticket: number): void {
    this.#db.prepare("delete from release_members where repo = ? and ticket = ?").run(repo, ticket);
  }

  /** Returns true when no alert with this key was sent within the window. */
  shouldAlert(key: string, windowMs: number): boolean {
    const row = this.#db.prepare("select sent_at from alerts where key = ?").get(key);
    if (row && Date.now() - Date.parse(String(row["sent_at"])) < windowMs) return false;
    this.#db
      .prepare("insert into alerts (key, sent_at) values (?, ?) on conflict (key) do update set sent_at = excluded.sent_at")
      .run(key, new Date().toISOString());
    return true;
  }

  clearAlert(key: string): void {
    this.#db.prepare("delete from alerts where key = ?").run(key);
  }

  stopAttempt(id: number): void {
    this.#db.prepare("update attempts set status = 'stopped' where id = ?").run(id);
  }

  close(): void {
    this.#db.close();
  }
}
