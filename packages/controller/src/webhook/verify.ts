import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies GitHub's X-Hub-Signature-256 header against the raw body. */
export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"), "utf8");
  const received = Buffer.from(header.slice("sha256=".length), "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
