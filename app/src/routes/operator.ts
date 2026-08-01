import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { S3Client, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BedrockAgentClient, StartIngestionJobCommand, GetIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";
import { requireOperator } from "../auth/session.js";
import { issueToken } from "../auth/token.js";
import { deriveParticipantId } from "../auth/credentials.js";
import { config } from "../config.js";
import { invalidateGuideCache } from "../ai/ask.js";
import {
  listAllAiQueries,
  listParticipants,
  getGuideReindexState,
  startGuideReindex,
  updateGuideReindexStatus,
} from "../db/repo.js";

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

const s3 = new S3Client({});
const bedrockAgent = new BedrockAgentClient({});
const GUIDE_BUCKET = process.env.GUIDE_BUCKET;
const KB_ID = process.env.BEDROCK_KB_ID;
const KB_DATA_SOURCE_ID = process.env.BEDROCK_KB_DATA_SOURCE_ID;

const ACTIVE_PREFIX = "guide/";
const INACTIVE_PREFIX = "guide-inactive/";

// Bedrock Knowledge Base's own supported-format/size limits (docs.aws.amazon.com/bedrock —
// knowledge-base-ds.html) — enforced here too so a rejected upload fails fast instead of
// silently sitting unindexed.
const GUIDE_EXTENSIONS = new Set([".txt", ".md", ".html", ".doc", ".docx", ".csv", ".xls", ".xlsx", ".pdf"]);
const IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png"]);
const GUIDE_MAX_BYTES = 50 * 1024 * 1024;
const IMAGE_MAX_BYTES = Math.floor(3.75 * 1024 * 1024);

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i).toLowerCase();
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

  // ---------- AI query log (operator-wide, unlike the participant's own-history view) ----------
  app.get("/api/operator/ai-queries", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const queries = await listAllAiQueries();
    queries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    reply.send({ queries });
  });

  // ---------- Attendance ----------
  // "Registered" here means a participant's account has actually been created (participants are
  // pseudonymous IDs backed by a shared passphrase or Cognito password, not real AWS accounts —
  // this app deliberately doesn't do Workshop Studio-style account vending, see README). So the
  // only real 2-stage pipeline is: derivable-but-never-seen vs. has a DynamoDB ParticipantItem
  // (i.e. has logged in at least once).
  app.get("/api/operator/attendance", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const joined = await listParticipants();
    const joinedIds = new Set(joined.map((p) => p.participantId));
    const noShows = Array.from({ length: config.participantCount }, (_, i) => deriveParticipantId(config.sessionSecret, i))
      .filter((id) => !joinedIds.has(id))
      .map((participantId, i) => ({ participantId, index: i, joinUrl: buildJoinUrl(req, participantId) }));
    reply.send({
      // noShowCount is `noShows.length`, not `expectedCount - joinedCount` — the passphrase
      // login fallback lets anyone join with a self-chosen numeric ID outside the deterministic
      // roster (participantCount=0 during setup, or just extra test logins), so joined can
      // exceed expected and the subtraction would go negative.
      expectedCount: config.participantCount,
      joinedCount: joined.length,
      noShowCount: noShows.length,
      noShows,
    });
  });

  app.post("/api/operator/attendance/:participantId/resend", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const { participantId } = req.params as { participantId: string };
    reply.send({ joinUrl: buildJoinUrl(req, participantId) });
  });

  // ---------- Guide documents (Bedrock Knowledge Base / prompt-injection fallback source) ----------
  app.get("/api/operator/guide-docs", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!GUIDE_BUCKET) return reply.send({ docs: [] });

    const [active, inactive] = await Promise.all([
      s3.send(new ListObjectsV2Command({ Bucket: GUIDE_BUCKET, Prefix: ACTIVE_PREFIX })),
      s3.send(new ListObjectsV2Command({ Bucket: GUIDE_BUCKET, Prefix: INACTIVE_PREFIX })),
    ]);
    const toDoc = (o: { Key?: string; Size?: number; LastModified?: Date }, active: boolean) => ({
      key: o.Key!,
      name: o.Key!.slice(o.Key!.indexOf("/") + 1),
      sizeBytes: o.Size ?? 0,
      active,
      lastModified: o.LastModified?.toISOString() ?? null,
    });
    const docs = [
      ...(active.Contents ?? []).filter((o) => o.Key !== ACTIVE_PREFIX).map((o) => toDoc(o, true)),
      ...(inactive.Contents ?? []).filter((o) => o.Key !== INACTIVE_PREFIX).map((o) => toDoc(o, false)),
    ];
    reply.send({ docs });
  });

  app.post("/api/operator/guide-docs/presign", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!GUIDE_BUCKET) return reply.code(503).send({ error: "guide bucket not configured" });

    const { filename, contentType, sizeBytes } = req.body as { filename?: string; contentType?: string; sizeBytes?: number };
    if (!filename || !sizeBytes) return reply.code(400).send({ error: "filename and sizeBytes required" });
    const ext = extOf(filename);
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const isDoc = GUIDE_EXTENSIONS.has(ext);
    if (!isImage && !isDoc) return reply.code(400).send({ error: `unsupported extension ${ext}` });
    const limit = isImage ? IMAGE_MAX_BYTES : GUIDE_MAX_BYTES;
    if (sizeBytes > limit) return reply.code(400).send({ error: `size exceeds ${limit} bytes for ${ext}` });

    const key = `${ACTIVE_PREFIX}${filename}`;
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: GUIDE_BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: 300 },
    );
    reply.send({ url, key });
  });

  app.post("/api/operator/guide-docs/uploaded", async (req, reply) => {
    // The browser PUTs directly to S3 (presigned URL above); this just invalidates the
    // fallback-mode cache so a KB-disabled deploy picks up the new file without a restart.
    if (!requireOperator(req, reply)) return;
    invalidateGuideCache();
    reply.send({ ok: true });
  });

  app.delete("/api/operator/guide-docs", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!GUIDE_BUCKET) return reply.code(503).send({ error: "guide bucket not configured" });
    const key = (req.query as any)?.key as string | undefined;
    if (!key) return reply.code(400).send({ error: "key required" });
    await s3.send(new DeleteObjectCommand({ Bucket: GUIDE_BUCKET, Key: key }));
    invalidateGuideCache();
    reply.send({ ok: true });
  });

  app.post("/api/operator/guide-docs/toggle", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!GUIDE_BUCKET) return reply.code(503).send({ error: "guide bucket not configured" });
    const key = (req.query as any)?.key as string | undefined;
    if (!key) return reply.code(400).send({ error: "key required" });

    const activatedNow = key.startsWith(INACTIVE_PREFIX);
    const name = key.slice(key.indexOf("/") + 1);
    const newKey = `${activatedNow ? ACTIVE_PREFIX : INACTIVE_PREFIX}${name}`;
    const copySource = `${GUIDE_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
    await s3.send(new CopyObjectCommand({ Bucket: GUIDE_BUCKET, CopySource: copySource, Key: newKey }));
    await s3.send(new DeleteObjectCommand({ Bucket: GUIDE_BUCKET, Key: key }));
    invalidateGuideCache();
    reply.send({ ok: true, key: newKey, active: activatedNow });
  });

  app.post("/api/operator/guide-docs/reindex", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!KB_ID || !KB_DATA_SOURCE_ID) {
      return reply.code(501).send({ error: "knowledge base not enabled for this deployment" });
    }
    const res = await bedrockAgent.send(
      new StartIngestionJobCommand({ knowledgeBaseId: KB_ID, dataSourceId: KB_DATA_SOURCE_ID }),
    );
    const jobId = res.ingestionJob?.ingestionJobId ?? "";
    await startGuideReindex(jobId, res.ingestionJob?.status ?? "STARTING");
    reply.send({ jobId, status: res.ingestionJob?.status ?? "STARTING" });
  });

  app.get("/api/operator/guide-docs/reindex-status", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const state = await getGuideReindexState();
    if (!state) return reply.send({ status: null });
    if (!KB_ID || !KB_DATA_SOURCE_ID || !["STARTING", "IN_PROGRESS"].includes(state.status)) {
      return reply.send({ status: state.status, startedAt: state.startedAt });
    }
    const res = await bedrockAgent.send(
      new GetIngestionJobCommand({ knowledgeBaseId: KB_ID, dataSourceId: KB_DATA_SOURCE_ID, ingestionJobId: state.jobId }),
    );
    const status = res.ingestionJob?.status ?? state.status;
    if (status !== state.status) await updateGuideReindexStatus(status);
    reply.send({ status, startedAt: state.startedAt });
  });
}
