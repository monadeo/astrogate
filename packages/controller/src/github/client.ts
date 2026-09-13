import { signAppJwt } from "./jwt.js";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";

export interface TokenScope {
  repositories?: string[];
  permissions?: Record<string, "read" | "write">;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: string;

  constructor(status: number, method: string, path: string, body: string) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

export class GitHubApp {
  readonly #appId: number;
  readonly #privateKey: string;
  readonly #installationId: number;
  readonly #tokens = new Map<string, CachedToken>();

  constructor(appId: number, privateKey: string, installationId: number) {
    this.#appId = appId;
    this.#privateKey = privateKey;
    this.#installationId = installationId;
  }

  appJwt(): string {
    return signAppJwt(this.#appId, this.#privateKey);
  }

  /** Installation token, cached per scope until five minutes before expiry. */
  async installationToken(scope: TokenScope = {}): Promise<string> {
    const key = JSON.stringify(scope);
    const cached = this.#tokens.get(key);
    if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;
    const body: Record<string, unknown> = {};
    if (scope.repositories) body["repositories"] = scope.repositories;
    if (scope.permissions) body["permissions"] = scope.permissions;
    const data = await this.request<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${this.#installationId}/access_tokens`,
      body,
      this.appJwt(),
    );
    this.#tokens.set(key, { token: data.token, expiresAt: Date.parse(data.expires_at) });
    return data.token;
  }

  async request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const auth = token ?? (await this.installationToken());
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${auth}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "astrogate",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new GitHubApiError(response.status, method, path, text);
    return (text.length === 0 ? undefined : JSON.parse(text)) as T;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const data = await this.request<{ data?: T; errors?: { message: string }[] }>("POST", "/graphql", { query, variables });
    if (data.errors && data.errors.length > 0) {
      throw new GitHubApiError(200, "POST", "/graphql", data.errors.map((e) => e.message).join("; "));
    }
    if (data.data === undefined) throw new GitHubApiError(200, "POST", "/graphql", "empty data");
    return data.data;
  }
}
