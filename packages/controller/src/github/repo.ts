import type { GitHubApp } from "./client.js";

export interface IssueInfo {
  nodeId: string;
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  state: "open" | "closed";
  labels: string[];
}

export interface PullInfo {
  number: number;
  nodeId: string;
  htmlUrl: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  merged: boolean;
}

export interface CheckRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
}

interface RawIssue {
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  labels: { name: string }[];
}

interface RawPull {
  number: number;
  node_id: string;
  html_url: string;
  head: { sha: string; ref: string };
  base: { ref: string };
  merged: boolean;
}

function toIssue(raw: RawIssue): IssueInfo {
  return { nodeId: raw.node_id, number: raw.number, title: raw.title, body: raw.body ?? "", htmlUrl: raw.html_url, state: raw.state, labels: raw.labels.map((l) => l.name) };
}

function toPull(raw: RawPull): PullInfo {
  return { number: raw.number, nodeId: raw.node_id, htmlUrl: raw.html_url, headSha: raw.head.sha, headRef: raw.head.ref, baseRef: raw.base.ref, merged: raw.merged };
}

/** REST calls the controller makes on a repository; every write on GitHub goes through here. */
export class RepoApi {
  readonly #github: GitHubApp;

  constructor(github: GitHubApp) {
    this.#github = github;
  }

  issue(repo: string, number: number): Promise<IssueInfo> {
    return this.#github.request<RawIssue>("GET", `/repos/${repo}/issues/${number}`).then(toIssue);
  }

  async comments(repo: string, number: number): Promise<{ id: number; user: string; body: string; createdAt: string }[]> {
    const raw = await this.#github.request<{ id: number; user: { login: string }; body: string; created_at: string }[]>(
      "GET",
      `/repos/${repo}/issues/${number}/comments?per_page=100`,
    );
    return raw.map((c) => ({ id: c.id, user: c.user.login, body: c.body, createdAt: c.created_at }));
  }

  comment(repo: string, number: number, body: string): Promise<void> {
    return this.#github.request<unknown>("POST", `/repos/${repo}/issues/${number}/comments`, { body }).then(() => undefined);
  }

  createIssue(repo: string, title: string, body: string): Promise<IssueInfo> {
    return this.#github.request<RawIssue>("POST", `/repos/${repo}/issues`, { title, body }).then(toIssue);
  }

  async openPulls(repo: string, head: string): Promise<PullInfo[]> {
    const owner = repo.split("/")[0];
    const raw = await this.#github.request<RawPull[]>("GET", `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`);
    return raw.map(toPull);
  }

  pull(repo: string, number: number): Promise<PullInfo> {
    return this.#github.request<RawPull>("GET", `/repos/${repo}/pulls/${number}`).then(toPull);
  }

  createPull(repo: string, title: string, body: string, head: string, base: string): Promise<PullInfo> {
    return this.#github.request<RawPull>("POST", `/repos/${repo}/pulls`, { title, body, head, base }).then(toPull);
  }

  mergePull(repo: string, number: number, sha: string): Promise<void> {
    return this.#github
      .request<unknown>("PUT", `/repos/${repo}/pulls/${number}/merge`, { merge_method: "squash", sha })
      .then(() => undefined);
  }

  async checkRuns(repo: string, sha: string): Promise<CheckRunSummary[]> {
    const raw = await this.#github.request<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(
      "GET",
      `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
    );
    return raw.check_runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
  }

  createCheckRun(repo: string, sha: string, name: string, success: boolean, title: string, summary: string): Promise<void> {
    return this.#github
      .request<unknown>("POST", `/repos/${repo}/check-runs`, {
        name,
        head_sha: sha,
        status: "completed",
        conclusion: success ? "success" : "failure",
        output: { title, summary: summary.slice(0, 60_000) },
      })
      .then(() => undefined);
  }

  async branchExists(repo: string, branch: string): Promise<boolean> {
    try {
      await this.#github.request<unknown>("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      return true;
    } catch {
      return false;
    }
  }

  async branchSha(repo: string, branch: string): Promise<string> {
    const raw = await this.#github.request<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    return raw.object.sha;
  }

  createBranch(repo: string, branch: string, sha: string): Promise<void> {
    return this.#github.request<unknown>("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha }).then(() => undefined);
  }

  deleteBranch(repo: string, branch: string): Promise<void> {
    return this.#github.request<unknown>("DELETE", `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`).then(() => undefined);
  }

  /** Merges `head` into `base` on GitHub without a pull request. */
  mergeBranches(repo: string, base: string, head: string, message: string): Promise<void> {
    return this.#github.request<unknown>("POST", `/repos/${repo}/merges`, { base, head, commit_message: message }).then(() => undefined);
  }

  dispatchWorkflow(repo: string, workflowFile: string, ref: string, inputs: Record<string, string> = {}, tag = ref): Promise<void> {
    const expanded = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.replaceAll("{ref}", ref).replaceAll("{tag}", tag)]));
    return this.#github
      .request<unknown>("POST", `/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`, {
        ref,
        ...(Object.keys(expanded).length > 0 ? { inputs: expanded } : {}),
      })
      .then(() => undefined);
  }

  createTag(repo: string, tag: string, sha: string): Promise<void> {
    return this.#github.request<unknown>("POST", `/repos/${repo}/git/refs`, { ref: `refs/tags/${tag}`, sha }).then(() => undefined);
  }

  async isEmpty(repo: string): Promise<boolean> {
    const branches = await this.#github.request<unknown[]>("GET", `/repos/${repo}/branches?per_page=1`);
    return branches.length === 0;
  }

  /** First commit on an empty repository; creates the default branch. */
  createFile(repo: string, path: string, content: string, message: string): Promise<void> {
    return this.#github
      .request<unknown>("PUT", `/repos/${repo}/contents/${path}`, { message, content: Buffer.from(content, "utf8").toString("base64") })
      .then(() => undefined);
  }

  async openIssuesTitled(repo: string, title: string): Promise<IssueInfo[]> {
    const raw = await this.#github.request<RawIssue[]>("GET", `/repos/${repo}/issues?state=open&per_page=100`);
    return raw.filter((i) => i.title === title).map(toIssue);
  }

  async defaultBranch(repo: string): Promise<string> {
    const raw = await this.#github.request<{ default_branch: string }>("GET", `/repos/${repo}`);
    return raw.default_branch;
  }
}
