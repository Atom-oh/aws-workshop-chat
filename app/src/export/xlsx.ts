import ExcelJS from "exceljs";
import {
  listChannels,
  listMessages,
  listParticipants,
  listAiQueriesForParticipant,
  listTimeline,
} from "../db/repo.js";

// §8.2 fixed column contracts. accountId is renamed participantId throughout (see plan's
// deliberate deviation: identities here are synthetic, not real AWS account IDs).

export const QUESTIONS_COLUMNS = [
  "ts",
  "participantId",
  "channel",
  "threadId",
  "body",
  "status",
  "resolvedAtMin",
  "responder",
  "upvotes",
  "labStep",
] as const;

export const AI_QUERIES_COLUMNS = [
  "ts",
  "participantId",
  "query",
  "refDocs",
  "answerSummary",
  "feedback",
  "labStep",
  "tokensIn",
  "tokensOut",
] as const;

export const PARTICIPANTS_COLUMNS = [
  "participantId",
  "displayName",
  "questionCount",
  "aiQueryCount",
  "firstSeen",
  "lastSeen",
  "silent",
] as const;

export const TIMELINE_COLUMNS = ["ts", "participantId", "event", "channel", "refId", "labStep"] as const;

// Not part of §8.2's fixed contract — added so a truncated export (a page-size bug, a query
// that silently stopped early) shows up as a visibly wrong row count instead of looking
// complete. §8.1's absolute rule is "the export is trustworthy," which a bare 4-sheet file
// can't prove on its own.
export const META_COLUMNS = ["sheet", "rowCount"] as const;

export interface ExportData {
  questions: Array<Record<(typeof QUESTIONS_COLUMNS)[number], unknown>>;
  aiQueries: Array<Record<(typeof AI_QUERIES_COLUMNS)[number], unknown>>;
  participants: Array<Record<(typeof PARTICIPANTS_COLUMNS)[number], unknown>>;
  timeline: Array<Record<(typeof TIMELINE_COLUMNS)[number], unknown>>;
  generatedAt: string;
}

function addSheet<T extends Record<string, unknown>>(
  wb: ExcelJS.Workbook,
  name: string,
  columns: readonly string[],
  rows: T[],
) {
  const sheet = wb.addWorksheet(name);
  sheet.columns = columns.map((key) => ({ header: key, key }));
  for (const row of rows) sheet.addRow(row);
}

/** Pure builder — no I/O. Kept separate from data fetching so it's unit-testable with seeded rows. */
export function buildWorkbook(data: ExportData): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  addSheet(wb, "Questions", QUESTIONS_COLUMNS, data.questions);
  addSheet(wb, "AI_Queries", AI_QUERIES_COLUMNS, data.aiQueries);
  addSheet(wb, "Participants", PARTICIPANTS_COLUMNS, data.participants);
  addSheet(wb, "Timeline", TIMELINE_COLUMNS, data.timeline);
  addSheet(wb, "Meta", META_COLUMNS, [
    { sheet: "generatedAt", rowCount: data.generatedAt },
    { sheet: "Questions", rowCount: data.questions.length },
    { sheet: "AI_Queries", rowCount: data.aiQueries.length },
    { sheet: "Participants", rowCount: data.participants.length },
    { sheet: "Timeline", rowCount: data.timeline.length },
  ]);
  return wb;
}

/** Gathers current state from DynamoDB and shapes it into the export contract above. */
export async function fetchExportData(): Promise<ExportData> {
  const channels = await listChannels();
  const allMessages = (
    await Promise.all(channels.map((c: any) => listMessages(c.pk.replace("CHANNEL#", ""))))
  ).flat();

  const questions = allMessages
    .filter((m: any) => m.kind === "question")
    .map((m: any) => ({
      ts: m.createdAt,
      participantId: m.participantId,
      channel: m.channel,
      threadId: m.threadId ?? "",
      body: m.body,
      status: m.status,
      resolvedAtMin: m.resolvedAt ?? "",
      responder: m.responder ?? "",
      upvotes: m.upvotes ?? 0,
      labStep: m.labStep,
    }));

  const participants = await listParticipants();
  const aiQueries = (
    await Promise.all(participants.map((p) => listAiQueriesForParticipant(p.participantId)))
  ).flat();

  const aiQueryRows = aiQueries.map((q) => ({
    ts: q.createdAt,
    participantId: q.participantId,
    query: q.query,
    refDocs: (q.refDocs ?? []).join(", "),
    answerSummary: q.answerSummary,
    feedback: q.feedback ?? "",
    labStep: q.labStep,
    tokensIn: q.tokensIn,
    tokensOut: q.tokensOut,
  }));

  const participantRows = participants.map((p) => ({
    participantId: p.participantId,
    displayName: p.displayName,
    questionCount: p.questionCount ?? 0,
    aiQueryCount: p.aiQueryCount ?? 0,
    firstSeen: p.firstSeen,
    lastSeen: p.lastSeen,
    silent: (p.questionCount ?? 0) === 0 && (p.aiQueryCount ?? 0) === 0,
  }));

  const timeline = (await listTimeline()).map((e) => ({
    ts: e.createdAt,
    participantId: e.participantId,
    event: e.event,
    channel: e.channel ?? "",
    refId: e.refId ?? "",
    labStep: e.labStep,
  }));

  return {
    questions,
    aiQueries: aiQueryRows,
    participants: participantRows,
    timeline,
    generatedAt: new Date().toISOString(),
  };
}

export async function buildCurrentWorkbook(): Promise<ExcelJS.Workbook> {
  return buildWorkbook(await fetchExportData());
}
