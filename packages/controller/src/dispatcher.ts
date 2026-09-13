import type { WebhookEvent } from "./webhook/server.js";
import { log } from "./log.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Summarizes a GitHub event for the log; handlers attach here as they land. */
export function describeEvent(event: WebhookEvent): string {
  const payload = isRecord(event.payload) ? event.payload : {};
  const action = typeof payload["action"] === "string" ? payload["action"] : "";
  const repo = isRecord(payload["repository"]) && typeof payload["repository"]["full_name"] === "string"
    ? payload["repository"]["full_name"]
    : "";
  return [event.event, action, repo].filter((part) => part.length > 0).join(" ");
}

export function dispatch(event: WebhookEvent): void {
  log("event", describeEvent(event), { delivery: event.deliveryId });
}
