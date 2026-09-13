import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature } from "./verify.js";

const secret = "s3cret";
const body = Buffer.from('{"action":"opened"}');
const good = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifySignature", () => {
  it("accepts a matching signature", () => {
    expect(verifySignature(secret, body, good)).toBe(true);
  });
  it("rejects a wrong secret", () => {
    expect(verifySignature("other", body, good)).toBe(false);
  });
  it("rejects a missing or malformed header", () => {
    expect(verifySignature(secret, body, undefined)).toBe(false);
    expect(verifySignature(secret, body, "sha1=abc")).toBe(false);
    expect(verifySignature(secret, body, "sha256=00")).toBe(false);
  });
});
