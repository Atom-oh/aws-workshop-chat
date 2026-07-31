import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkbook,
  QUESTIONS_COLUMNS,
  AI_QUERIES_COLUMNS,
  PARTICIPANTS_COLUMNS,
  TIMELINE_COLUMNS,
  type ExportData,
} from "../src/export/xlsx.js";

const seed: ExportData = {
  questions: [
    {
      ts: "2026-07-30T09:00:00.000Z",
      participantId: "100000000001",
      channel: "questions",
      threadId: "",
      body: "왜 안돼요?",
      status: "resolved",
      resolvedAtMin: "2026-07-30T09:05:00.000Z",
      responder: "운영자",
      upvotes: 3,
      labStep: "step-2",
    },
    {
      ts: "2026-07-30T09:10:00.000Z",
      participantId: "100000000002",
      channel: "announcements", // archived channel — must still appear in the export
      threadId: "",
      body: "아카이브된 채널 질문",
      status: "open",
      resolvedAtMin: "",
      responder: "",
      upvotes: 0,
      labStep: "step-2",
    },
  ],
  aiQueries: [
    {
      ts: "2026-07-30T09:02:00.000Z",
      participantId: "100000000001",
      query: "S3 bucket policy?",
      refDocs: "guide/s3.md",
      answerSummary: "Use a bucket policy with...",
      feedback: "up",
      labStep: "step-2",
      tokensIn: 120,
      tokensOut: 80,
    },
  ],
  participants: [
    {
      participantId: "100000000001",
      displayName: "0001",
      questionCount: 1,
      aiQueryCount: 1,
      firstSeen: "2026-07-30T08:55:00.000Z",
      lastSeen: "2026-07-30T09:10:00.000Z",
      silent: false,
    },
    {
      participantId: "100000000003",
      displayName: "0003",
      questionCount: 0,
      aiQueryCount: 0,
      firstSeen: "2026-07-30T08:55:00.000Z",
      lastSeen: "2026-07-30T08:55:00.000Z",
      silent: true,
    },
  ],
  timeline: [
    { ts: "2026-07-30T08:55:00.000Z", participantId: "100000000001", event: "login", channel: "", refId: "", labStep: "intro" },
  ],
};

test("produces exactly the four §8.2 sheets", () => {
  const wb = buildWorkbook(seed);
  const names = wb.worksheets.map((s) => s.name);
  assert.deepEqual(names, ["Questions", "AI_Queries", "Participants", "Timeline"]);
});

test("each sheet has exactly the fixed column contract, in order", () => {
  const wb = buildWorkbook(seed);
  const headerRow = (name: string) =>
    (wb.getWorksheet(name)!.getRow(1).values as unknown[]).filter((v) => v !== undefined) as string[];

  assert.deepEqual(headerRow("Questions"), [...QUESTIONS_COLUMNS]);
  assert.deepEqual(headerRow("AI_Queries"), [...AI_QUERIES_COLUMNS]);
  assert.deepEqual(headerRow("Participants"), [...PARTICIPANTS_COLUMNS]);
  assert.deepEqual(headerRow("Timeline"), [...TIMELINE_COLUMNS]);
});

test("row counts match input, including archived-channel and silent-participant rows", () => {
  const wb = buildWorkbook(seed);
  assert.equal(wb.getWorksheet("Questions")!.rowCount, 1 + seed.questions.length);
  assert.equal(wb.getWorksheet("Participants")!.rowCount, 1 + seed.participants.length);

  const silentCol = PARTICIPANTS_COLUMNS.indexOf("silent") + 1;
  const silentRow = wb.getWorksheet("Participants")!.getRow(3); // header=1, row1=data#1, row2=data#2
  assert.equal(silentRow.getCell(silentCol).value, true);
});

test("archived channel's question still appears in the export", () => {
  const wb = buildWorkbook(seed);
  const channelCol = QUESTIONS_COLUMNS.indexOf("channel") + 1;
  const values = [2, 3].map((r) => wb.getWorksheet("Questions")!.getRow(r).getCell(channelCol).value);
  assert.ok(values.includes("announcements"));
});

test("empty data still produces four sheets with headers only", () => {
  const wb = buildWorkbook({ questions: [], aiQueries: [], participants: [], timeline: [] });
  for (const name of ["Questions", "AI_Queries", "Participants", "Timeline"]) {
    assert.equal(wb.getWorksheet(name)!.rowCount, 1);
  }
});
