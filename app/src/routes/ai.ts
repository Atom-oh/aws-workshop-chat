import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/session.js";
import { ask } from "../ai/ask.js";
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

  app.post("/api/ai/:aiUlid/feedback", async (req, reply) => {
    const session = requireSession(req, reply);
    if (!session) return;
    const { feedback } = req.body as { feedback?: "up" | "down" };
    if (feedback !== "up" && feedback !== "down") return reply.code(400).send({ error: "feedback must be up or down" });
    await setAiFeedback(session.participantId, (req.params as any).aiUlid, feedback);
    reply.send({ ok: true });
  });
}
