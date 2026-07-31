import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { requireOperator } from "../auth/session.js";
import { issueToken } from "../auth/token.js";
import { deriveParticipantId } from "../auth/credentials.js";
import { config } from "../config.js";

// §5.4/§10: "operator console credential table" — one row per participant, ID + a ready-to-use
// join link (and QR), re-derived on demand from the same seed the deploy-time provisioner used.
// Nothing here is stored separately; raising PARTICIPANT_COUNT and redeploying just grows this
// list, matching the credentials provisioner's own idempotent behavior.

function buildJoinUrl(req: any, participantId: string): string {
  const exp = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds;
  const token = issueToken({ participantId, role: "participant", exp }, config.sessionSecret);
  const origin = `${req.protocol}://${req.headers.host}`;
  return `${origin}/j?t=${encodeURIComponent(token)}`;
}

export async function operatorRoutes(app: FastifyInstance) {
  app.get("/api/operator/roster", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const roster = Array.from({ length: config.participantCount }, (_, i) => {
      const participantId = deriveParticipantId(config.sessionSecret, i);
      return { participantId, joinUrl: buildJoinUrl(req, participantId) };
    });
    reply.send({ roster, participantPassphrase: config.participantPassphrase });
  });

  app.get("/api/operator/roster.csv", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const rows = Array.from({ length: config.participantCount }, (_, i) => {
      const participantId = deriveParticipantId(config.sessionSecret, i);
      return `${participantId},${buildJoinUrl(req, participantId)}`;
    });
    reply
      .header("Content-Type", "text/csv")
      .header("Content-Disposition", 'attachment; filename="roster.csv"')
      .send(["participantId,joinUrl", ...rows].join("\n"));
  });

  app.get("/api/operator/roster/:index/qr.png", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const index = Number((req.params as any).index);
    if (!Number.isInteger(index) || index < 0 || index >= config.participantCount) {
      return reply.code(404).send({ error: "index out of range" });
    }
    const participantId = deriveParticipantId(config.sessionSecret, index);
    const png = await QRCode.toBuffer(buildJoinUrl(req, participantId), { type: "png", width: 300 });
    reply.header("Content-Type", "image/png").send(png);
  });
}
