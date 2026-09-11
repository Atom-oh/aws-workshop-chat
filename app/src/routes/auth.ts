import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { verifyToken } from "../auth/token.js";
import { mintSessionCookie, readSession, isSessionAllowed } from "../auth/session.js";
import { parseNickname } from "../auth/nickname.js";
import { verifyParticipantPassword, getUserRole } from "../auth/cognito.js";
import { config } from "../config.js";
import { keys, type ParticipantItem } from "../db/model.js";
import { getParticipant, putParticipant, registerNicknameParticipant, recordTimelineEvent, getLabStep } from "../db/repo.js";

async function ensureParticipantRecord(participantId: string) {
  const existing = await getParticipant(participantId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const participant: ParticipantItem = {
    ...keys.participant(participantId),
    participantId,
    displayName: participantId.split("@")[0].slice(-4),
    pwHash: "",
    questionCount: 0,
    aiQueryCount: 0,
    firstSeen: now,
    lastSeen: now,
    blocked: false,
  };
  await putParticipant(participant);
  return participant;
}

async function onLoginSuccess(participantId: string) {
  await ensureParticipantRecord(participantId);
  await recordTimelineEvent({ participantId, event: "login", labStep: await getLabStep() });
}

export async function authRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  app.post("/api/login/nickname", { bodyLimit: 1024 }, async (req, reply) => {
    if (config.participantAuthMode !== "nickname") {
      return reply.code(403).send({ error: "nickname login is disabled" });
    }
    const parsed = parseNickname((req.body as { nickname?: unknown } | null)?.nickname);
    if ("error" in parsed) return reply.code(400).send(parsed);

    // Retrying entry with a valid cookie must not create another attendee or reset a block.
    const session = readSession(req);
    const existing = session?.role === "participant" ? await getParticipant(session.participantId) : undefined;
    if (existing?.blocked) return reply.code(403).send({ error: "participant is blocked" });

    const now = new Date().toISOString();
    const participantId = existing?.participantId ?? `guest-${randomUUID()}`;
    const participant: ParticipantItem = existing ?? {
      ...keys.participant(participantId),
      participantId,
      displayName: parsed.nickname,
      authMode: "nickname",
      pwHash: "",
      questionCount: 0,
      aiQueryCount: 0,
      firstSeen: now,
      lastSeen: now,
      blocked: false,
    };
    if (!existing) {
      await registerNicknameParticipant(participant, await getLabStep());
    }
    mintSessionCookie(reply, {
      participantId, role: "participant", authMode: "nickname", displayName: participant.displayName,
    });
    return reply.send({ ok: true });
  });

  // One-click join links remain available for Cognito participants and operators.
  // Nickname participants use the shared app URL instead of an individual identity link.
  app.get("/j", async (req, reply) => {
    const t = (req.query as any)?.t as string | undefined;
    // This is the primary entry point for most participants — a raw JSON 403 here is a dead
    // end with no way back in. Redirect to the login screen with an error flag it knows to
    // render as a friendly "link expired, log in with ID/password instead" notice.
    if (!t) return reply.redirect("/?error=expired_link");

    // Fastify has already decoded the query parameter.
    const payload = typeof t === "string" ? verifyToken(t, config.sessionSecret) : null;
    if (!payload) return reply.redirect("/?error=expired_link");
    if (!isSessionAllowed(payload)) return reply.redirect("/");

    // Operator links must not touch onLoginSuccess — it creates a participant DB record and a
    // login timeline event, which would falsely count the operator as a participant in
    // attendance stats and the xlsx export (see /api/login/operator, which skips it too).
    if (payload.role === "participant") {
      const participant = await getParticipant(payload.participantId);
      if (participant?.blocked) return reply.redirect("/?error=expired_link");
      await onLoginSuccess(payload.participantId);
    }
    mintSessionCookie(reply, {
      participantId: payload.participantId, role: payload.role, sessionSuffix: payload.sessionSuffix,
      authMode: payload.authMode, displayName: payload.displayName,
    });
    reply.redirect(payload.role === "operator" ? "/operator" : "/");
  });

  // Cognito passwords authenticate operators in either mode, and participants in Cognito
  // mode. Role comes entirely from Cognito group membership (assigned at creation, see
  // infra/lambda/credentials-handler.ts), never from which button was clicked or a hardcoded
  // username comparison. The operator's session participantId is normalized to the literal
  // "operator" (not their real Cognito username) because every display-name/avatar special
  // case elsewhere (format.tsx, ChannelView, the announcements guard) keys off that exact
  // string — there is only ever one operator account, so this is safe.
  app.post("/api/login/id", async (req, reply) => {
    const { id, password } = (req.body ?? {}) as { id?: string; password?: string };
    if (typeof id !== "string" || typeof password !== "string" || !id || !password) {
      return reply.code(400).send({ error: "missing fields" });
    }
    const ok = await verifyParticipantPassword(id, password);
    if (!ok) return reply.code(403).send({ error: "invalid credentials" });
    const role = await getUserRole(id);
    if (role === "admin") {
      mintSessionCookie(reply, { participantId: "operator", role: "operator" });
      return reply.send({ ok: true });
    }
    if (role === "participant" && config.participantAuthMode === "cognito") {
      await onLoginSuccess(id);
      mintSessionCookie(reply, { participantId: id, role: "participant" });
      return reply.send({ ok: true });
    }
    reply.code(403).send({ error: "invalid credentials" });
  });

  app.get("/api/session", async (req, reply) => {
    const session = readSession(req);
    reply.send({ session, participantAuthMode: config.participantAuthMode });
  });

  app.post("/api/logout", async (_req, reply) => {
    reply.clearCookie("wc_session", { path: "/" });
    reply.send({ ok: true });
  });
}
