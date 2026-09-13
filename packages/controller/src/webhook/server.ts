import { createServer, type Server } from "node:http";
import { log } from "../log.js";
import { verifySignature } from "./verify.js";

export interface WebhookEvent {
  deliveryId: string;
  event: string;
  payload: unknown;
}

export interface WebhookServerOptions {
  host: string;
  port: number;
  path: string;
  secret: string;
  /** Returns false when the delivery id was already processed. */
  accept: (deliveryId: string, event: string) => boolean;
  onEvent: (event: WebhookEvent) => void;
}

const MAX_BODY_BYTES = 25 * 1024 * 1024;

export function startWebhookServer(options: WebhookServerOptions): Server {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== options.path) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const signature = req.headers["x-hub-signature-256"];
      if (!verifySignature(options.secret, body, typeof signature === "string" ? signature : undefined)) {
        log("webhook", "rejected delivery with bad signature");
        res.writeHead(401).end();
        return;
      }
      const deliveryId = req.headers["x-github-delivery"];
      const event = req.headers["x-github-event"];
      if (typeof deliveryId !== "string" || typeof event !== "string") {
        res.writeHead(400).end();
        return;
      }
      if (!options.accept(deliveryId, event)) {
        res.writeHead(202).end();
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      // GitHub expects a 2xx within 10 seconds; the handler runs after the response.
      res.writeHead(202).end();
      setImmediate(() => options.onEvent({ deliveryId, event, payload }));
    });
  });
  server.listen(options.port, options.host, () => {
    log("webhook", `listening on http://${options.host}:${options.port}${options.path}`);
  });
  return server;
}
