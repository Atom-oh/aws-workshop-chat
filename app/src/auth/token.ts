// Signed tokens for two purposes:
//  - the /j?t=<token> one-click join link (§5.4)
//  - the session cookie minted after /j or fallback login
// Both are HMAC-SHA256 over a JSON payload, base64url-encoded, constant-time verified.
// No JWT library: the payload shape is fixed and tiny, and avoiding one avoids a dependency
// whose main job (alg confusion, header parsing) we don't need for a single trusted signer.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionPayload {
  participantId: string;
  role: "participant" | "operator";
  authMode?: "cognito" | "nickname"; // absent on legacy Cognito join links and sessions
  displayName?: string;
  sessionSuffix?: string; // e.g. "-2" for a second concurrent session, sticky-bound at login
  exp: number; // unix seconds
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function issueToken(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(body, secret);
  return `${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = sign(body, secret);

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.participantId !== "string" || !payload.participantId) return null;
  if (payload.role !== "participant" && payload.role !== "operator") return null;
  if (payload.authMode !== undefined && payload.authMode !== "cognito" && payload.authMode !== "nickname") return null;
  if (payload.displayName !== undefined && typeof payload.displayName !== "string") return null;
  return payload;
}
