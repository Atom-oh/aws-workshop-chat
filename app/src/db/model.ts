// Single source of truth for DynamoDB key construction. See docs/DATA_MODEL.md.
// Nothing else in the app builds a PK/SK string by hand.

export const TABLE_NAME = process.env.TABLE_NAME ?? "WorkshopChat";

export type QuestionStatus = "open" | "resolved";
export type MessageKind = "msg" | "question";
export type TimelineEvent = "login" | "upload" | "question" | "resolve" | "ai_query";

export interface MessageItem {
  pk: string;
  sk: string;
  participantId: string;
  body: string;
  kind: MessageKind;
  channel: string;
  threadId?: string;
  labStep: string;
  upvotes: number;
  upvoterIds?: string[]; // who has upvoted, so a second click toggles the upvote off
  status?: QuestionStatus;
  deleted: boolean;
  media: string[];
  createdAt: string; // ISO, derived from ulid at write time for convenience
  replyCount?: number; // denormalized count of thread replies, bumped in postThreadReply
}

export interface ParticipantItem {
  pk: string;
  sk: "META";
  participantId: string;
  displayName: string;
  pwHash: string;
  questionCount: number;
  aiQueryCount: number;
  firstSeen: string;
  lastSeen: string;
  blocked: boolean;
}

export interface AiQueryItem {
  pk: string;
  sk: string;
  participantId: string;
  query: string;
  refDocs: string[];
  answerSummary: string;
  feedback: "up" | "down" | null;
  labStep: string;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
}

export interface GuideReindexItem {
  pk: "WORKSHOP";
  sk: "GUIDE_REINDEX";
  jobId: string;
  // Raw Bedrock ingestion job status (STARTING/IN_PROGRESS/COMPLETE/FAILED) while a job is
  // running, plus two states the retry loop derives itself once a job completes:
  // RETRY_SCHEDULED (some docs came back with 0 chunks, a touch-and-restart is queued) and
  // EXHAUSTED (still failing after maxAttempts — stop retrying, surface it to the operator).
  status: string;
  startedAt: string;
  attempt: number; // 1-based; reset to 1 whenever a human clicks "reindex now"
  failedDocs: string[]; // doc names with zero indexed chunks after the last completed job
  nextRetryAt?: string; // set while status === RETRY_SCHEDULED
}

export interface TimelineItem {
  pk: "WORKSHOP";
  sk: string;
  gsi2pk: "WORKSHOP";
  gsi2sk: string;
  participantId: string;
  event: TimelineEvent;
  channel?: string;
  refId?: string;
  labStep: string;
  createdAt: string;
}

// zero-pad upvotes to 4 digits so lexical GSI sort order == numeric order
export function padUpvotes(n: number): string {
  return String(Math.max(0, Math.min(9999, n))).padStart(4, "0");
}

export const keys = {
  channel: (slug: string) => ({ pk: `CHANNEL#${slug}`, sk: "META" }),
  message: (slug: string, ulid: string) => ({ pk: `CHANNEL#${slug}`, sk: `MSG#${ulid}` }),
  threadReply: (rootUlid: string, ulid: string) => ({ pk: `THREAD#${rootUlid}`, sk: `MSG#${ulid}` }),
  questionIndex: (status: QuestionStatus, upvotes: number, ulid: string) => ({
    pk: `QSTATUS#${status}`,
    sk: `${padUpvotes(upvotes)}#${ulid}`,
  }),
  participant: (participantId: string) => ({ pk: `USER#${participantId}`, sk: "META" as const }),
  aiQuery: (participantId: string, ulid: string) => ({ pk: `USER#${participantId}`, sk: `AI#${ulid}` }),
  timeline: (ulid: string) => ({
    pk: "WORKSHOP" as const,
    sk: `EVT#${ulid}`,
    gsi2pk: "WORKSHOP" as const,
    gsi2sk: `EVT#${ulid}`,
  }),
  labStep: () => ({ pk: "WORKSHOP", sk: "LABSTEP" }),
  exportState: () => ({ pk: "WORKSHOP", sk: "EXPORT" }),
  guideReindex: () => ({ pk: "WORKSHOP" as const, sk: "GUIDE_REINDEX" as const }),
};

// ponytail: no secondary indexes needed. QSTATUS# and WORKSHOP are already distinct base-table
// partition keys, so "one query per export sheet" is achieved by PK partitioning alone —
// a GSI would duplicate what the base table already gives us for free.
