import { loadConfig, loadSecrets } from "../config.js";
import { DiscordNotifier } from "../discord/notifier.js";
import { Engine } from "../flow/engine.js";
import { GitHubApp } from "../github/client.js";
import { ProjectBoard } from "../github/projects.js";
import { RepoApi } from "../github/repo.js";
import { log } from "../log.js";
import type { Paths } from "../paths.js";
import { SessionServer } from "../sessions/socket.js";
import { StateDb } from "../state/db.js";
import { startWebhookServer } from "../webhook/server.js";

const TICK_MS = 15 * 60_000;

function report(scope: string): (error: unknown) => void {
  return (error) => log(scope, error instanceof Error ? error.message : String(error));
}

export async function serve(paths: Paths): Promise<void> {
  const config = loadConfig(paths);
  const secrets = loadSecrets(paths);
  const db = new StateDb(paths.stateDb);
  const github = new GitHubApp(config.github.appId, secrets.appPrivateKey, config.github.installationId);
  const repos = new RepoApi(github);
  const board = new ProjectBoard(github, config.github.org, config.github.projectNumber);
  const discord = new DiscordNotifier(secrets.discordWebhookUrl);

  const app = await github.request<{ slug: string }>("GET", "/app", undefined, github.appJwt());
  await board.load();
  log("serve", `authenticated as GitHub App ${app.slug}`, { board: board.url, projects: config.projects.map((p) => p.repo) });

  const holder: { engine?: Engine } = {};
  const sessions = new SessionServer(paths.socket, {
    onRegister: (session) => holder.engine?.onRegister(session),
    onMessage: (session, message) => void holder.engine?.onMessage(session, message).catch(report("session")),
    onClose: (session) => void holder.engine?.onClose(session).catch(report("session")),
  });
  await sessions.listen();
  const live = new Engine({ config, db, github, repos, board, sessions, discord, socketPath: paths.socket });
  holder.engine = live;

  const webhook = startWebhookServer({
    host: config.listen.host,
    port: config.listen.port,
    path: config.listen.path,
    secret: secrets.webhookSecret,
    accept: (deliveryId, event) => db.recordDelivery(deliveryId, event),
    onEvent: (event) => void live.onEvent(event).catch(report("event")),
  });

  // Sessions from before a restart reconnect within seconds; give them that head start.
  setTimeout(() => void live.recover().catch(report("recover")), 10_000);
  const ticker = setInterval(() => void live.tick().catch(report("tick")), TICK_MS);

  const shutdown = (): void => {
    log("serve", "shutting down");
    clearInterval(ticker);
    webhook.close();
    sessions.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
