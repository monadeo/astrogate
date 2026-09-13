import { log } from "../log.js";

export class DiscordNotifier {
  readonly #webhookUrl: string;

  constructor(webhookUrl: string) {
    this.#webhookUrl = webhookUrl;
  }

  async post(content: string): Promise<void> {
    const response = await fetch(this.#webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (!response.ok) {
      log("discord", `webhook returned ${response.status}`, { body: (await response.text()).slice(0, 200) });
    }
  }
}
