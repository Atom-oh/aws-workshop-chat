import type { FastifyInstance } from "fastify";
import { verifyToken } from "../auth/token.js";
import { mintSessionCookie, readSession } from "../auth/session.js";
import { verifyParticipantPassword, getUserRole } from "../auth/cognito.js";
import { config } from "../config.js";
import { getParticipant, putParticipant, recordTimelineEvent, getLabStep } from "../db/repo.js";

async function ensureParticipantRecord(participantId: string) {
  const existing = await getParticipant(participantId);
  if (existing) return;
  const now = new Date().toISOString();
  await putParticipant({
    pk: `USER#${participantId}`,
    sk: "META",
    participantId,
    displayName: participantId.split("@")[0].slice(-4),
    pwHash: "",
    questionCount: 0,
    aiQueryCount: 0,
    firstSeen: now,
    lastSeen: now,
    blocked: false,
  });
}

async function onLoginSuccess(participantId: string) {
  await ensureParticipantRecord(participantId);
  await recordTimelineEvent({ participantId, event: "login", labStep: await getLabStep() });
}

export async function authRoutes(app: FastifyInstance) {
  // One-click join link: /j?t=<signed token>. This is the primary path (§5.4) — the operator
  // console hands out one of these per participant, generated at deploy from the same seed
  // used to create the Cognito user, so no typing is ever required.
  app.get("/j", async (req, reply) => {
    const t = (req.query as any)?.t as string | undefined;
    if (!t) return reply.code(400).send({ error: "missing token" });

    const payload = verifyToken(decodeURIComponent(t), config.sessionSecret);
    if (!payload) return reply.code(403).send({ error: "invalid or expired join link" });

    // Operator links must not touch onLoginSuccess — it creates a participant DB record and a
    // login timeline event, which would falsely count the operator as a participant in
    // attendance stats and the xlsx export (see /api/login/operator, which skips it too).
    if (payload.role === "participant") await onLoginSuccess(payload.participantId);
    mintSessionCookie(reply, { participantId: payload.participantId, role: payload.role, sessionSuffix: payload.sessionSuffix });
    reply.redirect(payload.role === "operator" ? "/operator" : "/");
  });

  // Single Cognito ID + password form for BOTH the participant and the
  // operator — there is no "which kind of login is this" choice for the person typing, only
  // for the app: role comes entirely from Cognito group membership (assigned at creation, see
  // infra/lambda/credentials-handler.ts), never from which button was clicked or a hardcoded
  // username comparison. The operator's session participantId is normalized to the literal
  // "operator" (not their real Cognito username) because every display-name/avatar special
  // case elsewhere (format.tsx, ChannelView, the announcements guard) keys off that exact
  // string — there is only ever one operator account, so this is safe.
  app.post("/api/login/id", async (req, reply) => {
    const { id, password } = req.body as { id?: string; password?: string };
    if (!id || !password) return reply.code(400).send({ error: "missing fields" });
    const ok = await verifyParticipantPassword(id, password);
    if (!ok) return reply.code(403).send({ error: "invalid credentials" });
    const role = await getUserRole(id);
    if (role === "admin") {
      mintSessionCookie(reply, { participantId: "operator", role: "operator" });
      return reply.send({ ok: true });
    }
    if (role === "participant") {
      await onLoginSuccess(id);
      mintSessionCookie(reply, { participantId: id, role: "participant" });
      return reply.send({ ok: true });
    }
    reply.code(403).send({ error: "invalid credentials" });
  });

  app.get("/api/session", async (req, reply) => {
    const session = readSession(req);
    reply.send({ session });
  });

  app.post("/api/logout", async (_req, reply) => {
    reply.clearCookie("wc_session", { path: "/" });
    reply.send({ ok: true });
  });
}
