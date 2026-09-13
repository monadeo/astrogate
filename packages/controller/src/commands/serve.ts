import { loadConfig, loadSecrets } from "../config.js";
import { dispatch } from "../dispatcher.js";
import { DiscordNotifier } from "../discord/notifier.js";
import { GitHubApp } from "../github/client.js";
import { log } from "../log.js";
import type { Paths } from "../paths.js";
import { SessionServer } from "../sessions/socket.js";
import { StateDb } from "../state/db.js";
import { startWebhookServer } from "../webhook/server.js";

export async function serve(paths: Paths): Promise<void> {
  const config = loadConfig(paths);
  const secrets = loadSecrets(paths);
  const db = new StateDb(paths.stateDb);
  const github = new GitHubApp(config.github.appId, secrets.appPrivateKey, config.github.installationId);
  const discord = new DiscordNotifier(secrets.discordWebhookUrl);

  const sessions = new SessionServer(paths.socket, {
    onRegister: (session) => log("session", "registered", { ...session.registration }),
    onMessage: (session, message) => log("session", message.kind, { role: session.registration.role, ticket: session.registration.ticket }),
    onClose: (session) => log("session", "closed", { role: session.registration.role, ticket: session.registration.ticket }),
  });
  await sessions.listen();

  const webhook = startWebhookServer({
    host: config.listen.host,
    port: config.listen.port,
    path: config.listen.path,
    secret: secrets.webhookSecret,
    accept: (deliveryId, event) => db.recordDelivery(deliveryId, event),
    onEvent: dispatch,
  });

  try {
    const app = await github.request<{ slug: string }>("GET", "/app", undefined, github.appJwt());
    log("serve", `authenticated as GitHub App ${app.slug}`, { projects: config.projects.map((p) => p.repo) });
  } catch (error) {
    log("serve", `GitHub App authentication failed: ${error instanceof Error ? error.message : String(error)}`);
    webhook.close();
    sessions.close();
    db.close();
    process.exit(1);
  }
  void discord;

  const shutdown = (): void => {
    log("serve", "shutting down");
    webhook.close();
    sessions.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
