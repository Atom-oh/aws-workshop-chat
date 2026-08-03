// Autonomous retry loop for lab-guide Knowledge Base ingestion. Runs in-process (this app is
// already a single always-on Fargate task — see CLAUDE.md's "why a single task" note — so a
// setInterval here needs no separate Lambda/EventBridge stack) and survives independently of
// whether the operator console happens to be open.
//
// Why retries are needed at all: Bedrock's incremental sync only reprocesses a document whose S3
// object actually changed since its last *attempted* sync — it does NOT retry a document just
// because that attempt failed. Confirmed by re-running StartIngestionJob against this exact
// workshop's data source: `numberOfDocumentsScanned: 6, new/modified/failed: 0` for a chapter
// that had zero chunks in the vector store. So "click reindex again" alone never fixes a failed
// document — the S3 object has to look changed first, which `touchGuideDocs` does by re-copying
// it onto itself.
import { BedrockAgentClient, StartIngestionJobCommand, GetIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";
import { S3Client, ListObjectsV2Command, CopyObjectCommand } from "@aws-sdk/client-s3";
import {
  getGuideReindexState,
  updateGuideReindexStatus,
  setGuideReindexOutcome,
  bumpGuideReindexAttempt,
} from "../db/repo.js";
import type { GuideReindexItem } from "../db/model.js";
import { countChunksBySource } from "./guide-index.js";

const KB_ID = process.env.BEDROCK_KB_ID;
const KB_DATA_SOURCE_ID = process.env.BEDROCK_KB_DATA_SOURCE_ID;
const GUIDE_BUCKET = process.env.GUIDE_BUCKET;
const ACTIVE_PREFIX = "guide/";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2, 5, 10].map((min) => min * 60_000); // wait before attempt 2, 3, (never — attempt 3 exhausts)
const POLL_INTERVAL_MS = 30_000;

const bedrockAgent = new BedrockAgentClient({ region: process.env.BEDROCK_REGION });
const s3 = new S3Client({});

async function listActiveGuideDocNames(): Promise<string[]> {
  if (!GUIDE_BUCKET) return [];
  const res = await s3.send(new ListObjectsV2Command({ Bucket: GUIDE_BUCKET, Prefix: ACTIVE_PREFIX }));
  return (res.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => !!k && k !== ACTIVE_PREFIX)
    .map((k) => k.slice(ACTIVE_PREFIX.length));
}

async function touchGuideDocs(names: string[]) {
  await Promise.all(
    names.map(async (name) => {
      const key = `${ACTIVE_PREFIX}${name}`;
      const copySource = `${GUIDE_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
      await s3.send(new CopyObjectCommand({ Bucket: GUIDE_BUCKET, CopySource: copySource, Key: key, MetadataDirective: "REPLACE" }));
    }),
  );
}

export async function reconcileCompletedJob(state: GuideReindexItem) {
  const [chunkCounts, activeDocs] = await Promise.all([countChunksBySource(), listActiveGuideDocNames()]);
  if (!chunkCounts) {
    await updateGuideReindexStatus("COMPLETE");
    return;
  }
  const failedDocs = activeDocs.filter((name) => (chunkCounts[name] ?? 0) === 0);

  if (failedDocs.length === 0) {
    await setGuideReindexOutcome("COMPLETE", []);
    return;
  }
  if (state.attempt >= MAX_ATTEMPTS) {
    await setGuideReindexOutcome("EXHAUSTED", failedDocs);
    return;
  }
  const waitMs = BACKOFF_MS[state.attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
  await setGuideReindexOutcome("RETRY_SCHEDULED", failedDocs, new Date(Date.now() + waitMs).toISOString());
}

async function retryFailedDocs(state: GuideReindexItem) {
  await touchGuideDocs(state.failedDocs);
  const res = await bedrockAgent.send(new StartIngestionJobCommand({ knowledgeBaseId: KB_ID, dataSourceId: KB_DATA_SOURCE_ID }));
  await bumpGuideReindexAttempt(res.ingestionJob?.ingestionJobId ?? "", res.ingestionJob?.status ?? "STARTING", state.attempt + 1);
}

let ticking = false;

async function tick() {
  if (ticking) return; // a slow tick (large index, throttled API) shouldn't overlap the next one
  ticking = true;
  try {
    const state = await getGuideReindexState();
    if (!state) return;

    if (state.status === "STARTING" || state.status === "IN_PROGRESS") {
      const res = await bedrockAgent.send(
        new GetIngestionJobCommand({ knowledgeBaseId: KB_ID, dataSourceId: KB_DATA_SOURCE_ID, ingestionJobId: state.jobId }),
      );
      const jobStatus = res.ingestionJob?.status ?? state.status;
      if (jobStatus === "COMPLETE" || jobStatus === "FAILED") await reconcileCompletedJob(state);
      else if (jobStatus !== state.status) await updateGuideReindexStatus(jobStatus);
      return;
    }

    if (state.status === "RETRY_SCHEDULED" && state.nextRetryAt && new Date(state.nextRetryAt) <= new Date()) {
      await retryFailedDocs(state);
    }
    // COMPLETE / FAILED / EXHAUSTED: nothing to do until a human clicks "reindex now" again.
  } catch (err) {
    console.error("[reindex-retry] tick failed:", err);
  } finally {
    ticking = false;
  }
}

export function startReindexRetryLoop() {
  if (!KB_ID || !KB_DATA_SOURCE_ID) return; // region fallback deploy — no KB to retry against
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[reindex-retry] watching guide-doc ingestion every ${POLL_INTERVAL_MS / 1000}s (max ${MAX_ATTEMPTS} attempts)`);
}
