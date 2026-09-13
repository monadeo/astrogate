import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  home: string;
  config: string;
  secrets: string;
  appPrivateKey: string;
  webhookSecret: string;
  discordWebhookUrl: string;
  stateDb: string;
  socket: string;
}

export function resolvePaths(home = join(homedir(), ".astrogate")): Paths {
  const secrets = join(home, "secrets");
  return {
    home,
    config: join(home, "config.json"),
    secrets,
    appPrivateKey: join(secrets, "github-app.pem"),
    webhookSecret: join(secrets, "webhook-secret"),
    discordWebhookUrl: join(secrets, "discord-webhook-url"),
    stateDb: join(home, "state.sqlite"),
    // Sessions run as another OS user; a socket under /tmp is reachable by both.
    socket: "/tmp/astrogate.sock",
  };
}
