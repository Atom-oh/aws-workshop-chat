import type { FastifyRequest, FastifyReply } from "fastify";
import { issueToken, verifyToken, type SessionPayload } from "./token.js";
import { config } from "../config.js";

const COOKIE_NAME = "wc_session";

export function mintSessionCookie(reply: FastifyReply, payload: Omit<SessionPayload, "exp">) {
  const exp = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds;
  const token = issueToken({ ...payload, exp }, config.sessionSecret);
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: config.sessionTtlSeconds,
  });
}

export function readSession(req: FastifyRequest): SessionPayload | null {
  const cookie = req.cookies?.[COOKIE_NAME];
  if (!cookie) return null;
  const session = verifyToken(cookie, config.sessionSecret);
  return session && isSessionAllowed(session) ? session : null;
}

export function isSessionAllowed(session: SessionPayload): boolean {
  return session.role === "operator" || (session.authMode ?? "cognito") === config.participantAuthMode;
}

/** Route guard: 401s if there's no valid session. */
export function requireSession(req: FastifyRequest, reply: FastifyReply): SessionPayload | null {
  const session = readSession(req);
  if (!session) {
    reply.code(401).send({ error: "not authenticated" });
    return null;
  }
  return session;
}

/** Route guard: 403s if the session isn't the operator. */
export function requireOperator(req: FastifyRequest, reply: FastifyReply): SessionPayload | null {
  const session = requireSession(req, reply);
  if (!session) return null;
  if (session.role !== "operator") {
    reply.code(403).send({ error: "operator only" });
    return null;
  }
  return session;
}
