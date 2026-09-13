import { createSign } from "node:crypto";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * GitHub App JWT: RS256, issued 60 s in the past to absorb clock drift,
 * valid for 9 minutes (GitHub caps at 10).
 */
export function signAppJwt(appId: number, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${base64url(signature)}`;
}
