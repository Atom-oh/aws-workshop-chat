// Export is state, not an event (§8.1): this timer keeps exports/latest.xlsx on S3 fresh so a
// "right now" export always exists even if nobody clicks the button before the account is
// reclaimed. Single Fargate task => no duplicate-writer race, so no lock is needed.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db/client.js";
import { TABLE_NAME, keys } from "../db/model.js";
import { buildWorkbook, fetchExportData } from "./xlsx.js";

const EXPORT_BUCKET = process.env.EXPORT_BUCKET;
const EXPORT_INTERVAL_MS = 15 * 60 * 1000;
const s3 = new S3Client({});

export interface RowCounts {
  Questions: number;
  AI_Queries: number;
  Participants: number;
  Timeline: number;
}

export interface ExportStatus {
  lastExportAt: string | null;
  rowCounts: RowCounts | null;
}

export async function writeSnapshotNow(): Promise<{ s3Key: string; lastExportAt: string; rowCounts: RowCounts }> {
  // Fetched once, reused for both the workbook and the operator-visible row counts (§8.1) — the
  // count the operator sees is guaranteed to match what's actually in the file, not a second,
  // possibly-stale query.
  const data = await fetchExportData();
  const wb = buildWorkbook(data);
  const buffer = await wb.xlsx.writeBuffer();
  const s3Key = "exports/latest.xlsx";
  const lastExportAt = data.generatedAt;
  const rowCounts: RowCounts = {
    Questions: data.questions.length,
    AI_Queries: data.aiQueries.length,
    Participants: data.participants.length,
    Timeline: data.timeline.length,
  };

  if (EXPORT_BUCKET) {
    await s3.send(
      new PutObjectCommand({
        Bucket: EXPORT_BUCKET,
        Key: s3Key,
        Body: Buffer.from(buffer),
        ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );
  }

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...keys.exportState(), lastExportAt, s3Key, rowCounts },
    }),
  );
  return { s3Key, lastExportAt, rowCounts };
}

export async function getExportStatus(): Promise<ExportStatus> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.exportState() }));
  return { lastExportAt: res.Item?.lastExportAt ?? null, rowCounts: res.Item?.rowCounts ?? null };
}

export function startSnapshotTimer() {
  const timer = setInterval(() => {
    writeSnapshotNow().catch((err) => console.error("[snapshot] failed:", err));
  }, EXPORT_INTERVAL_MS);
  timer.unref?.(); // never blocks graceful shutdown
  return timer;
}
