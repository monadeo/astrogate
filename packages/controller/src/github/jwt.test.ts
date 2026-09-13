import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signAppJwt } from "./jwt.js";

describe("signAppJwt", () => {
  it("produces a verifiable RS256 token with GitHub's claims", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const token = signAppJwt(42, pem, 1_000_000);
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "42" });
    const ok = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });
});
