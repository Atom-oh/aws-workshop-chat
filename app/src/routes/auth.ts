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
    displayName: participantId.slice(-4),
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

    await onLoginSuccess(payload.participantId);
    mintSessionCookie(reply, { participantId: payload.participantId, role: payload.role, sessionSuffix: payload.sessionSuffix });
    reply.redirect("/");
  });

  // Fallback #1 (§5.4, §12.4): participant ID + one shared passphrase, never per-participant
  // passwords typed by hand. Always available regardless of Cognito/SSM state.
  app.post("/api/login/passphrase", async (req, reply) => {
    const { participantId, passphrase } = req.body as { participantId?: string; passphrase?: string };
    if (!participantId || !/^\d{6,20}$/.test(participantId)) {
      return reply.code(400).send({ error: "participantId must be numeric" });
    }
    if (passphrase !== config.participantPassphrase) {
      return reply.code(403).send({ error: "wrong passphrase" });
    }
    await onLoginSuccess(participantId);
    mintSessionCookie(reply, { participantId, role: "participant" });
    reply.send({ ok: true });
  });

  // Fallback #2: participant types their individually-issued Cognito ID + password directly.
  // Role comes from Cognito group membership (assigned at creation, see
  // infra/lambda/credentials-handler.ts) — a correct password for a user who isn't in the
  // participant group (e.g. the admin account, typed in here by mistake) is rejected, not
  // silently logged in as a participant.
  app.post("/api/login/password", async (req, reply) => {
    const { participantId, password } = req.body as { participantId?: string; password?: string };
    if (!participantId || !password) return reply.code(400).send({ error: "missing fields" });
    const ok = await verifyParticipantPassword(participantId, password);
    if (!ok) return reply.code(403).send({ error: "invalid credentials" });
    const role = await getUserRole(participantId);
    if (role !== "participant") return reply.code(403).send({ error: "invalid credentials" });
    await onLoginSuccess(participantId);
    mintSessionCookie(reply, { participantId, role: "participant" });
    reply.send({ ok: true });
  });

  // Operator login is Cognito-backed like Fallback #2 above — the one operator account is
  // created at deploy time (infra/lib/workshop-chat-stack.ts) with a random password, and put
  // in the admin group by the same provisioner. Role comes from group membership, not a
  // hardcoded adminUsername comparison, so this route and the participant one above share the
  // same check (getUserRole) and differ only in which role they require.
  app.post("/api/login/operator", async (req, reply) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send({ error: "missing fields" });
    const ok = await verifyParticipantPassword(username, password);
    if (!ok) return reply.code(403).send({ error: "invalid credentials" });
    const role = await getUserRole(username);
    if (role !== "admin") return reply.code(403).send({ error: "invalid credentials" });
    mintSessionCookie(reply, { participantId: "operator", role: "operator" });
    reply.send({ ok: true });
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
