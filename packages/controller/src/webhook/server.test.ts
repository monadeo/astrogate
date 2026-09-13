import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startWebhookServer, type WebhookEvent } from "./server.js";

const secret = "hook-secret";
let close: (() => void) | undefined;

afterEach(() => close?.());

async function post(port: number, body: string, headers: Record<string, string>): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/webhook`, { method: "POST", body, headers });
  return response.status;
}

describe("webhook server", () => {
  it("accepts a signed delivery once and rejects bad signatures", async () => {
    const events: WebhookEvent[] = [];
    const seen = new Set<string>();
    const server = startWebhookServer({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook",
      secret,
      accept: (id) => (seen.has(id) ? false : (seen.add(id), true)),
      onEvent: (e) => events.push(e),
    });
    close = () => server.close();
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    const body = JSON.stringify({ action: "opened", repository: { full_name: "o/r" } });
    const good = { "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`, "x-github-delivery": "d1", "x-github-event": "issues" };

    expect(await post(port, body, good)).toBe(202);
    expect(await post(port, body, good)).toBe(202);
    expect(await post(port, body, { ...good, "x-hub-signature-256": "sha256=bad" })).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("issues");
  });
});
