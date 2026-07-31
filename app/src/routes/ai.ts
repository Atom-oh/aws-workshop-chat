import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/session.js";
import { ask, askStream } from "../ai/ask.js";
import { getLabStep, tryConsumeAiQuota, recordTimelineEvent, setAiFeedback } from "../db/repo.js";

export async function aiRoutes(app: FastifyInstance) {
  // AI answers never touch the channel broadcast (§6.3): they render only in the asker's own
  // view, so a wrong or noisy AI answer never pollutes the shared timeline.
  app.post("/api/ai/ask", async (req, reply) => {
    const session = requireSession(req, reply);
    if (!session) return;

    const { query } = req.body as { query?: string };
    if (!query) return reply.code(400).send({ error: "query required" });

    const underQuota = await tryConsumeAiQuota(session.participantId);
    if (!underQuota) return reply.code(429).send({ error: "daily AI quota exceeded" });

    const labStep = await getLabStep();
    const result = await ask({ participantId: session.participantId, query, labStep });
    await recordTimelineEvent({ participantId: session.participantId, event: "ai_query", labStep });
    reply.send(result);
  });

  // Same as /api/ai/ask but streams the answer as it's generated (Bedrock ConverseStream) via
  // Server-Sent Events, so the participant sees tokens arrive instead of waiting for the whole
  // response — the Converse round-trip alone can run several seconds on a full guide retrieval.
  app.post("/api/ai/ask/stream", async (req, reply) => {
    const session = requireSession(req, reply);
    if (!session) return;

    const { query } = req.body as { query?: string };
    if (!query) return reply.code(400).send({ error: "query required" });

    const underQuota = await tryConsumeAiQuota(session.participantId);
    if (!underQuota) return reply.code(429).send({ error: "daily AI quota exceeded" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const labStep = await getLabStep();
    try {
      const { refDocs, aiUlid } = await askStream({ participantId: session.participantId, query, labStep }, (chunk) => {
        reply.raw.write(`event: delta\ndata: ${JSON.stringify({ chunk })}\n\n`);
      });
      await recordTimelineEvent({ participantId: session.participantId, event: "ai_query", labStep });
      reply.raw.write(`event: done\ndata: ${JSON.stringify({ refDocs, aiUlid })}\n\n`);
    } catch (err: any) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    reply.raw.end();
  });

  app.post("/api/ai/:aiUlid/feedback", async (req, reply) => {
    const session = requireSession(req, reply);
    if (!session) return;
    const { feedback } = req.body as { feedback?: "up" | "down" };
    if (feedback !== "up" && feedback !== "down") return reply.code(400).send({ error: "feedback must be up or down" });
    await setAiFeedback(session.participantId, (req.params as any).aiUlid, feedback);
    reply.send({ ok: true });
  });
}
