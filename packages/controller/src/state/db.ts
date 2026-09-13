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
  status: "running" | "stopped";
  createdAt: string;
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
  status text not null default 'running',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (repo, ticket, attempt, role)
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

  insertAttempt(row: Omit<AttemptRow, "id" | "status" | "createdAt" | "sessionFile" | "pr">): AttemptRow {
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

  setPr(id: number, pr: number): void {
    this.#db.prepare("update attempts set pr = ? where id = ?").run(pr, id);
  }

  stopAttempt(id: number): void {
    this.#db.prepare("update attempts set status = 'stopped' where id = ?").run(id);
  }

  close(): void {
    this.#db.close();
  }
}
