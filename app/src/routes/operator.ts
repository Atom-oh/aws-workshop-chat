import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { S3Client, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BedrockAgentClient, StartIngestionJobCommand, GetIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";
import { requireOperator } from "../auth/session.js";
import { issueToken } from "../auth/token.js";
import { deriveParticipantId } from "../auth/credentials.js";
import { listParticipantIds } from "../auth/cognito.js";
import { config } from "../config.js";
import { invalidateGuideCache } from "../ai/ask.js";
import { countChunksBySource } from "../ai/guide-index.js";
import { reconcileCompletedJob } from "../ai/reindex-retry.js";
import {
  listAllAiQueries,
  listParticipants,
  getGuideReindexState,
  startGuideReindex,
  updateGuideReindexStatus,
} from "../db/repo.js";

// §5.4/§10: "operator console credential table" — one row per participant, ID + a ready-to-use
// join link (and QR).
//
// The roster's source of truth is Cognito's `participant` group (listParticipantIds) —
// participants are provisioned there by this repo's credentials-provisioner Lambda *or* by an
// external poller, depending on deployment, and either way Cognito is what actually accepts
// their login. `deriveParticipantId`/`config.participantCount` are only a fallback for local
// dev with no Cognito configured at all (COGNITO_USER_POOL_ID unset) — never trust
// participantCount as a production headcount, that's the bug this replaced.
// Callback-injected (same shape as provisionCredentials in auth/credentials.ts) so the
// null/array/throw branches are testable without a real Cognito user pool.
export async function resolveRosterWith(
  fetchCognitoIds: () => Promise<string[] | null>,
  derivedIds: string[],
): Promise<{ ids: string[]; source: "cognito" | "derived" }> {
  const cognitoIds = await fetchCognitoIds();
  if (cognitoIds) return { ids: cognitoIds, source: "cognito" };
  return { ids: derivedIds, source: "derived" };
}

async function resolveRoster(): Promise<{ ids: string[]; source: "cognito" | "derived" }> {
  const derivedIds = Array.from({ length: config.participantCount }, (_, i) => deriveParticipantId(config.sessionSecret, i));
  return resolveRosterWith(listParticipantIds, derivedIds);
}

function buildJoinUrl(req: any, participantId: string, role: "participant" | "operator" = "participant"): string {
  const exp = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds;
  const token = issueToken({ participantId, role, exp }, config.sessionSecret);
  const origin = `${req.protocol}://${req.headers.host}`;
  return `${origin}/j?t=${encodeURIComponent(token)}`;
}

// GUIDE_BUCKET can live in a different region than this task when a Bedrock Knowledge Base is
// enabled (the KB's S3 data source must be co-located with the KB — see infra/lib/bedrock-stack.ts)
// — explicit region avoids a PermanentRedirect from the SDK defaulting to this task's own region.
const s3 = new S3Client({ region: process.env.GUIDE_BUCKET_REGION });
const bedrockAgent = new BedrockAgentClient({ region: process.env.BEDROCK_REGION });
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

// participantId now comes from Cognito, which — depending on deployment — may be populated by
// an external poller rather than this app's own HMAC derivation, so it's no longer guaranteed
// to be a bare "<12 digits>@ws" string. Neutralize spreadsheet-formula injection (a value
// starting with =, +, -, or @ that Excel/Sheets would evaluate on open) and quote/escape commas
// the same way any other CSV writer would.
function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function operatorRoutes(app: FastifyInstance) {
  app.get("/api/operator/roster", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const { ids, source } = await resolveRoster();
    const roster = ids.map((participantId) => ({ participantId, joinUrl: buildJoinUrl(req, participantId) }));
    reply.send({ roster, source, participantPassphrase: config.participantPassphrase });
  });

  // A bookmarkable one-click login for the operator's own account — the same mechanism as the
  // participant join link above, just signed with role "operator". Gated by requireOperator so
  // minting one still requires a normal password login once.
  app.get("/api/operator/login-link", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    reply.send({ loginUrl: buildJoinUrl(req, "operator", "operator") });
  });

  app.get("/api/operator/roster.csv", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const { ids } = await resolveRoster();
    const rows = ids.map((participantId) => `${csvCell(participantId)},${csvCell(buildJoinUrl(req, participantId))}`);
    reply
      .header("Content-Type", "text/csv")
      .header("Content-Disposition", 'attachment; filename="roster.csv"')
      .send(["participantId,joinUrl", ...rows].join("\n"));
  });

  // Addressed by participantId, not a roster-array index — Cognito's ListUsersInGroup makes no
  // ordering guarantee between calls, so an index resolved against one roster fetch (the page
  // that rendered this link) could point at a different participant by the time this request
  // re-fetches the roster to validate it. The join link this mints is scoped to that one
  // participantId regardless, so there's nothing to validate against a roster anyway — this
  // route is just requireOperator-gated QR rendering of a token this operator could already
  // mint via /api/operator/roster.
  app.get("/api/operator/roster/:participantId/qr.png", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const { participantId } = req.params as { participantId: string };
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
  // only real 2-stage pipeline is: known-to-Cognito-but-never-seen vs. has a DynamoDB
  // ParticipantItem (i.e. has logged in at least once).
  app.get("/api/operator/attendance", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const { ids, source } = await resolveRoster();
    const joined = await listParticipants();
    const joinedIds = new Set(joined.map((p) => p.participantId));
    const noShows = ids
      .filter((id) => !joinedIds.has(id))
      .map((participantId) => ({ participantId, joinUrl: buildJoinUrl(req, participantId) }));
    reply.send({
      // expectedCount is ids.length; joinedCount only counts joined participants who are also
      // in ids. Both noShows and joinedCount partition the same roster (ids), so
      // expected = joined + noShow holds by construction. Counting *all* of `joined` here
      // (every historical DynamoDB ParticipantItem, including ones since removed from Cognito
      // or created outside this roster entirely) would break that: joined could exceed expected
      // and the two counts would contradict each other on screen.
      expectedCount: ids.length,
      joinedCount: ids.length - noShows.length,
      noShowCount: noShows.length,
      noShows,
      source,
    });
  });

  // ---------- Guide documents (Bedrock Knowledge Base / prompt-injection fallback source) ----------
  app.get("/api/operator/guide-docs", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!GUIDE_BUCKET) return reply.send({ docs: [] });

    const [active, inactive, chunkCounts, reindexState] = await Promise.all([
      s3.send(new ListObjectsV2Command({ Bucket: GUIDE_BUCKET, Prefix: ACTIVE_PREFIX })),
      s3.send(new ListObjectsV2Command({ Bucket: GUIDE_BUCKET, Prefix: INACTIVE_PREFIX })),
      countChunksBySource(),
      getGuideReindexState(),
    ]);
    // See guide-index.ts: Bedrock's own per-document status API can't be trusted here, so
    // "indexed" means "has at least one chunk in the vector store", counted directly.
    const indexStatus = (name: string, active: boolean): string | undefined => {
      if (!chunkCounts || !active) return undefined;
      if (reindexState?.status === "STARTING" || reindexState?.status === "IN_PROGRESS") return "indexing";
      if ((chunkCounts[name] ?? 0) > 0) return "indexed";
      if (reindexState?.failedDocs?.includes(name)) return reindexState.status === "EXHAUSTED" ? "failed" : "retrying";
      return "pending"; // uploaded, never yet part of a completed reindex
    };
    const toDoc = (o: { Key?: string; Size?: number; LastModified?: Date }, active: boolean) => {
      const name = o.Key!.slice(o.Key!.indexOf("/") + 1);
      return {
        key: o.Key!,
        name,
        sizeBytes: o.Size ?? 0,
        active,
        lastModified: o.LastModified?.toISOString() ?? null,
        indexStatus: indexStatus(name, active),
      };
    };
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
    // A human clicking this always gets a fresh retry budget (attempt=1), even if the previous
    // run ended EXHAUSTED — startGuideReindex resets attempt/failedDocs.
    await startGuideReindex(jobId, res.ingestionJob?.status ?? "STARTING");
    reply.send({ jobId, status: res.ingestionJob?.status ?? "STARTING" });
  });

  app.get("/api/operator/guide-docs/reindex-status", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    let state = await getGuideReindexState();
    if (!state) return reply.send({ status: null });

    if (KB_ID && KB_DATA_SOURCE_ID && (state.status === "STARTING" || state.status === "IN_PROGRESS")) {
      const res = await bedrockAgent.send(
        new GetIngestionJobCommand({ knowledgeBaseId: KB_ID, dataSourceId: KB_DATA_SOURCE_ID, ingestionJobId: state.jobId }),
      );
      const jobStatus = res.ingestionJob?.status ?? state.status;
      if (jobStatus === "COMPLETE" || jobStatus === "FAILED") {
        // Reconcile inline rather than waiting for the next 30s background tick — an operator
        // watching this exact screen shouldn't see a stale "인덱싱 중" for half a minute.
        await reconcileCompletedJob(state);
        state = await getGuideReindexState();
      } else if (jobStatus !== state.status) {
        await updateGuideReindexStatus(jobStatus);
        state = { ...state, status: jobStatus };
      }
    }
    reply.send({
      status: state!.status,
      startedAt: state!.startedAt,
      attempt: state!.attempt,
      maxAttempts: 3,
      failedDocs: state!.failedDocs ?? [],
      nextRetryAt: state!.nextRetryAt ?? null,
    });
  });
}
