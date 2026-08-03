import type { FastifyInstance } from "fastify";
import { requireSession, requireOperator } from "../auth/session.js";
import { broadcast } from "../ws/hub.js";
import {
  createChannel,
  archiveChannel,
  listChannels,
  registerChannelSlug,
  postMessage,
  postThreadReply,
  listMessages,
  listThreadReplies,
  upvoteQuestion,
  resolveQuestion,
  listQuestionsByStatus,
  softDeleteMessage,
  getParticipant,
  touchParticipant,
  setParticipantBlocked,
  listParticipants,
  getLabStep,
  setLabStep,
  recordTimelineEvent,
} from "../db/repo.js";

const MAX_BODY_LENGTH = 4000;
const MAX_MEDIA_PER_MESSAGE = 4;
const ANNOUNCEMENTS_SLUG = "announcements"; // seeded in bootstrap.ts; kept in sync with web/src/Chat.tsx

export async function chatRoutes(app: FastifyInstance) {
  app.get("/api/channels", async (_req, reply) => {
    reply.send({ channels: await listChannels() });
  });

  app.post("/api/channels", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const { slug, name } = req.body as { slug?: string; name?: string };
    if (!slug || !name) return reply.code(400).send({ error: "slug and name required" });
    await createChannel(slug, name);
    await registerChannelSlug(slug);
    reply.send({ ok: true });
  });

  app.post("/api/channels/:slug/archive", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    await archiveChannel((req.params as any).slug);
    reply.send({ ok: true });
  });

  app.get("/api/channels/:slug/messages", async (req, reply) => {
    if (!requireSession(req, reply)) return;
    // `after` (last-seen message ulid) lets a reconnecting client backfill only what it missed
    // instead of re-fetching everything (see web/src/Chat.tsx's reconnect handler).
    const { after } = req.query as { after?: string };
    const slug = (req.params as any).slug;
    reply.send({ messages: await listMessages(slug, after ? { after } : { limit: 100 }) });
  });

  app.get("/api/threads/:rootUlid", async (req, reply) => {
    if (!requireSession(req, reply)) return;
    reply.send({ replies: await listThreadReplies((req.params as any).rootUlid) });
  });

  app.post("/api/channels/:slug/messages", async (req, reply) => {
    const session = requireSession(req, reply);
    if (!session) return;

    const participant = await getParticipant(session.participantId);
    if (participant?.blocked) return reply.code(403).send({ error: "blocked by operator" });

    const { body, kind, threadId, media } = req.body as {
      body?: string;
      kind?: "msg" | "question";
      threadId?: string;
      media?: string[];
    };
    if (!body || body.length > MAX_BODY_LENGTH) {
      return reply.code(400).send({ error: `body required, max ${MAX_BODY_LENGTH} chars` });
    }
    if (media && media.length > MAX_MEDIA_PER_MESSAGE) {
      return reply.code(400).send({ error: `max ${MAX_MEDIA_PER_MESSAGE} media items` });
    }

    const slug = (req.params as any).slug;
    // The "공지로 올리기" UI button is operator-only, but that's just a hidden control — anyone
    // could otherwise POST straight to this channel and fake an announcement, so it's enforced
    // here too, not just in the client.
    if (slug === ANNOUNCEMENTS_SLUG && !threadId && session.role !== "operator") {
      return reply.code(403).send({ error: "only the operator can post announcements" });
    }
    const labStep = await getLabStep();

    let message;
    if (threadId) {
      const result = await postThreadReply(threadId, { channel: slug, participantId: session.participantId, body, labStep, media });
      message = result.message;
      broadcast(slug, { type: "threadReplyCount", rootUlid: threadId, replyCount: result.rootReplyCount });
    } else {
      message = await postMessage({
        channel: slug,
        participantId: session.participantId,
        body,
        kind: kind === "question" ? "question" : "msg",
        threadId,
        labStep,
        media,
      });
    }

    if (kind === "question") {
      await touchParticipant(session.participantId, "questionCount");
      await recordTimelineEvent({ participantId: session.participantId, event: "question", channel: slug, refId: message.sk, labStep });
    }
    if (media?.length) {
      await recordTimelineEvent({ participantId: session.participantId, event: "upload", channel: slug, refId: message.sk, labStep });
    }

    broadcast(slug, { type: "message", message });
    reply.send({ message });
  });

  app.post("/api/channels/:slug/messages/:ulid/upvote", async (req, reply) => {
    const session = requireSession(req, reply);
    if (!session) return;
    const { slug, ulid } = req.params as { slug: string; ulid: string };
    const { upvotes, upvoted } = await upvoteQuestion(slug, ulid, session.participantId);
    broadcast(slug, { type: "upvote", ulid, upvotes });
    reply.send({ upvotes, upvoted });
  });

  app.post("/api/channels/:slug/messages/:ulid/resolve", async (req, reply) => {
    const session = requireOperator(req, reply);
    if (!session) return;
    const { slug, ulid } = req.params as { slug: string; ulid: string };
    await resolveQuestion(slug, ulid, "운영자");
    await recordTimelineEvent({ participantId: session.participantId, event: "resolve", channel: slug, refId: ulid, labStep: await getLabStep() });
    broadcast(slug, { type: "resolved", ulid });
    reply.send({ ok: true });
  });

  app.get("/api/questions", async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const status = ((req.query as any)?.status ?? "open") as "open" | "resolved";
    reply.send({ questions: await listQuestionsByStatus(status) });
  });

  app.delete("/api/channels/:slug/messages/:ulid", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const { slug, ulid } = req.params as { slug: string; ulid: string };
    await softDeleteMessage(slug, ulid);
    broadcast(slug, { type: "deleted", ulid });
    reply.send({ ok: true });
  });

  app.post("/api/participants/:id/block", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    await setParticipantBlocked((req.params as any).id, true);
    reply.send({ ok: true });
  });

  app.post("/api/participants/:id/unblock", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    await setParticipantBlocked((req.params as any).id, false);
    reply.send({ ok: true });
  });

  app.get("/api/participants", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    reply.send({ participants: await listParticipants() });
  });

  app.get("/api/labstep", async (_req, reply) => {
    reply.send({ step: await getLabStep() });
  });

  app.post("/api/labstep", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const { step } = req.body as { step?: string };
    if (!step) return reply.code(400).send({ error: "step required" });
    await setLabStep(step);
    reply.send({ ok: true });
  });
}
