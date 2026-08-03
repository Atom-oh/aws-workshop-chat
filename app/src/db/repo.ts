import { ulid, decodeTime } from "ulid";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type QueryCommandInput,
  type ScanCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "./client.js";
import {
  TABLE_NAME,
  keys,
  padUpvotes,
  type MessageItem,
  type ParticipantItem,
  type AiQueryItem,
  type TimelineItem,
  type GuideReindexItem,
  type QuestionStatus,
  type MessageKind,
  type TimelineEvent,
} from "./model.js";

function isoFromUlid(id: string): string {
  return new Date(decodeTime(id)).toISOString();
}

// DynamoDB caps a single Query/Scan response at 1MB regardless of `Limit` — these two page
// through `LastEvaluatedKey` until it's exhausted so export reads (Timeline, Participants,
// AI_Queries, and unbounded Messages reads) never silently truncate at that boundary. Only used
// where the caller wants "everything" — screen-render reads keep their own small `Limit`.
async function queryAll<T = Record<string, unknown>>(input: Omit<QueryCommandInput, "ExclusiveStartKey">): Promise<T[]> {
  const items: T[] = [];
  let ExclusiveStartKey: QueryCommandInput["ExclusiveStartKey"];
  do {
    const res = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...((res.Items ?? []) as T[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function scanAll<T = Record<string, unknown>>(input: Omit<ScanCommandInput, "ExclusiveStartKey">): Promise<T[]> {
  const items: T[] = [];
  let ExclusiveStartKey: ScanCommandInput["ExclusiveStartKey"];
  do {
    const res = await ddb.send(new ScanCommand({ ...input, ExclusiveStartKey }));
    items.push(...((res.Items ?? []) as T[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// ---------- Channels ----------

export async function createChannel(slug: string, name: string, scaleVisible = true) {
  const k = keys.channel(slug);
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...k, name, archived: false, scaleVisible },
    }),
  );
}

export async function archiveChannel(slug: string) {
  const k = keys.channel(slug);
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: k,
      UpdateExpression: "SET archived = :t",
      ExpressionAttributeValues: { ":t": true },
    }),
  );
}

export async function listChannels() {
  // ponytail: channel count is single digits (announce/questions/chat + operator-created ones),
  // a scan-by-prefix via Query isn't available on PK alone so we keep a small known-slugs list
  // written at deploy time under WORKSHOP/CHANNELS instead of scanning the whole table.
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: "WORKSHOP", sk: "CHANNELS" } }),
  );
  // DynamoDB String Sets unmarshal to a JS Set, not an array.
  const slugs: string[] = res.Item?.slugs ? Array.from(res.Item.slugs) : [];
  const channels = await Promise.all(
    slugs.map((slug) =>
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.channel(slug) })).then((r) => r.Item),
    ),
  );
  return channels.filter(Boolean);
}

export async function registerChannelSlug(slug: string) {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: "WORKSHOP", sk: "CHANNELS" },
      UpdateExpression: "ADD slugs :s",
      ExpressionAttributeValues: { ":s": new Set([slug]) },
    }),
  );
}

// ---------- Messages / questions ----------

export async function postMessage(input: {
  channel: string;
  participantId: string;
  body: string;
  kind: MessageKind;
  threadId?: string;
  labStep: string;
  media?: string[];
}): Promise<MessageItem> {
  const id = ulid();
  const k = keys.message(input.channel, id);
  const item: MessageItem = {
    ...k,
    participantId: input.participantId,
    body: input.body,
    kind: input.kind,
    channel: input.channel,
    threadId: input.threadId,
    labStep: input.labStep,
    upvotes: 0,
    status: input.kind === "question" ? "open" : undefined,
    deleted: false,
    media: input.media ?? [],
    createdAt: isoFromUlid(id),
    replyCount: 0,
  };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  if (input.kind === "question") {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...keys.questionIndex("open", 0, id),
          gsi1pk: `QSTATUS#open`,
          gsi1sk: `${padUpvotes(0)}#${id}`,
          messageId: id,
          channel: input.channel,
          body: input.body,
          labStep: input.labStep,
        },
      }),
    );
  }
  return item;
}

export async function postThreadReply(rootUlid: string, input: {
  channel: string;
  participantId: string;
  body: string;
  labStep: string;
  media?: string[];
}): Promise<{ message: MessageItem; rootReplyCount: number }> {
  const id = ulid();
  const k = keys.threadReply(rootUlid, id);
  const item: MessageItem = {
    ...k,
    participantId: input.participantId,
    body: input.body,
    kind: "msg",
    channel: input.channel,
    threadId: rootUlid,
    labStep: input.labStep,
    upvotes: 0,
    deleted: false,
    media: input.media ?? [],
    createdAt: isoFromUlid(id),
  };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  // Denormalized onto the root message so the channel/board views can show "N개의 댓글"
  // without an N+1 query per row.
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.message(input.channel, rootUlid),
      UpdateExpression: "ADD replyCount :one",
      ExpressionAttributeValues: { ":one": 1 },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  const rootReplyCount = (res.Attributes?.replyCount as number) ?? 1;

  return { message: item, rootReplyCount };
}

export async function listMessages(channel: string, opts: { limit?: number; after?: string } = {}) {
  // `after` (a message ulid) drives the client's reconnect backfill: SK is `MSG#<ulid>` and
  // ulids are lexically time-sortable, so "> that SK" is exactly "everything since I last saw".
  const afterSk = opts.after ? `MSG#${opts.after}` : undefined;
  const input: QueryCommandInput = {
    TableName: TABLE_NAME,
    KeyConditionExpression: afterSk ? "pk = :pk AND sk > :after" : "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: afterSk
      ? { ":pk": `CHANNEL#${channel}`, ":after": afterSk }
      : { ":pk": `CHANNEL#${channel}`, ":prefix": "MSG#" },
    ScanIndexForward: true,
  };
  // A caller-supplied limit (screen render) is one page and stops there by design. No limit
  // (reconnect backfill, and the export path below) means "everything" — page through fully so
  // a channel with >1MB of history doesn't silently drop rows past that boundary.
  if (opts.limit) {
    // A limited fetch has no `after` cursor (see chat.ts), so this is always the initial page
    // load — that must be the most RECENT `limit` messages, not the oldest. Query descending
    // then reverse back to chronological order for display.
    const res = await ddb.send(new QueryCommand({ ...input, ScanIndexForward: false, Limit: opts.limit }));
    return (res.Items ?? []).reverse();
  }
  return queryAll(input);
}

export async function listThreadReplies(rootUlid: string) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `THREAD#${rootUlid}` },
      ScanIndexForward: true,
    }),
  );
  return res.Items ?? [];
}

export async function upvoteQuestion(channel: string, messageUlid: string, participantId: string) {
  // read-modify-write on both the message and its status-index projection: the index's SK
  // embeds the upvote count so it must be rewritten, not just ADD-ed, when it moves buckets.
  const msgKey = keys.message(channel, messageUlid);
  const cur = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: msgKey }));
  if (!cur.Item) throw new Error("message not found");
  const upvoterIds: string[] = cur.Item.upvoterIds ?? [];
  const alreadyUpvoted = upvoterIds.includes(participantId);
  const nextUpvoterIds = alreadyUpvoted
    ? upvoterIds.filter((id) => id !== participantId)
    : [...upvoterIds, participantId];
  const newUpvotes = nextUpvoterIds.length;
  const status: QuestionStatus = cur.Item.status ?? "open";

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: msgKey,
      UpdateExpression: "SET upvotes = :v, upvoterIds = :ids",
      ExpressionAttributeValues: { ":v": newUpvotes, ":ids": nextUpvoterIds },
    }),
  );

  // delete old index item, write new one at the new upvote bucket
  const oldKey = keys.questionIndex(status, cur.Item.upvotes ?? 0, messageUlid);
  const newKey = keys.questionIndex(status, newUpvotes, messageUlid);
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...newKey, messageId: messageUlid, channel, body: cur.Item.body, labStep: cur.Item.labStep },
    }),
  );
  if (oldKey.sk !== newKey.sk) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: oldKey,
        UpdateExpression: "REMOVE messageId",
      }),
    );
  }
  return { upvotes: newUpvotes, upvoted: !alreadyUpvoted };
}

export async function resolveQuestion(channel: string, messageUlid: string, responder: string) {
  const msgKey = keys.message(channel, messageUlid);
  const cur = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: msgKey }));
  if (!cur.Item) throw new Error("message not found");
  const resolvedAt = new Date().toISOString();

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: msgKey,
      UpdateExpression: "SET #s = :r, resolvedAt = :ts, responder = :resp",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":r": "resolved", ":ts": resolvedAt, ":resp": responder },
    }),
  );

  const oldKey = keys.questionIndex("open", cur.Item.upvotes ?? 0, messageUlid);
  const newKey = keys.questionIndex("resolved", cur.Item.upvotes ?? 0, messageUlid);
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...newKey,
        messageId: messageUlid,
        channel,
        body: cur.Item.body,
        labStep: cur.Item.labStep,
        resolvedAt,
        responder,
      },
    }),
  );
  await ddb.send(new UpdateCommand({ TableName: TABLE_NAME, Key: oldKey, UpdateExpression: "REMOVE messageId" }));
}

export async function listQuestionsByStatus(status: QuestionStatus) {
  const items = await queryAll({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": `QSTATUS#${status}` },
    ScanIndexForward: false, // highest upvotes first
  });
  return items.filter((i: any) => i.messageId);
}

export async function softDeleteMessage(channel: string, messageUlid: string) {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.message(channel, messageUlid),
      UpdateExpression: "SET deleted = :t",
      ExpressionAttributeValues: { ":t": true },
    }),
  );
}

// ---------- Participants ----------

export async function getParticipant(participantId: string): Promise<ParticipantItem | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.participant(participantId) }));
  return res.Item as ParticipantItem | undefined;
}

export async function putParticipant(item: ParticipantItem) {
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
}

export async function touchParticipant(participantId: string, field: "questionCount" | "aiQueryCount") {
  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.participant(participantId),
      UpdateExpression: `ADD ${field} :one SET lastSeen = :now`,
      ExpressionAttributeValues: { ":one": 1, ":now": now },
    }),
  );
}

export async function setParticipantBlocked(participantId: string, blocked: boolean) {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.participant(participantId),
      UpdateExpression: "SET blocked = :b",
      ExpressionAttributeValues: { ":b": blocked },
    }),
  );
}

export async function listParticipants(): Promise<ParticipantItem[]> {
  // ponytail: no participant-list GSI; N is bounded (<=500) so a table Scan filtered to
  // SK = META is acceptable for a 3-day app. Upgrade to a GSI if N grows past low thousands.
  // scanAll pages through LastEvaluatedKey — a single Scan page still caps at 1MB regardless
  // of item count, and Timeline/AI_Queries rows sharing this table make hitting that boundary
  // realistic well under 500 participants.
  return scanAll<ParticipantItem>({
    TableName: TABLE_NAME,
    FilterExpression: "sk = :meta AND begins_with(pk, :prefix)",
    ExpressionAttributeValues: { ":meta": "META", ":prefix": "USER#" },
  });
}

// ---------- AI queries ----------

export async function recordAiQuery(input: {
  participantId: string;
  query: string;
  refDocs: string[];
  answerSummary: string;
  labStep: string;
  tokensIn: number;
  tokensOut: number;
}): Promise<AiQueryItem> {
  const id = ulid();
  const item: AiQueryItem = {
    ...keys.aiQuery(input.participantId, id),
    participantId: input.participantId,
    query: input.query,
    refDocs: input.refDocs,
    answerSummary: input.answerSummary,
    feedback: null,
    labStep: input.labStep,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    createdAt: isoFromUlid(id),
  };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  await touchParticipant(input.participantId, "aiQueryCount");
  return item;
}

export async function setAiFeedback(participantId: string, aiUlid: string, feedback: "up" | "down") {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.aiQuery(participantId, aiUlid),
      UpdateExpression: "SET feedback = :f",
      ExpressionAttributeValues: { ":f": feedback },
    }),
  );
}

export async function listAiQueriesForParticipant(participantId: string): Promise<AiQueryItem[]> {
  return queryAll<AiQueryItem>({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `USER#${participantId}`, ":prefix": "AI#" },
  });
}

export async function listAllAiQueries(): Promise<AiQueryItem[]> {
  // Same scan-is-fine-at-this-scale reasoning as listParticipants above; scanAll pages through
  // LastEvaluatedKey for the same 1MB-page-cap reason.
  return scanAll<AiQueryItem>({
    TableName: TABLE_NAME,
    FilterExpression: "begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":prefix": "AI#" },
  });
}

// ---------- Guide document reindexing ----------

export async function getGuideReindexState(): Promise<GuideReindexItem | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.guideReindex() }));
  return res.Item as GuideReindexItem | undefined;
}

export async function startGuideReindex(jobId: string, status: string) {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...keys.guideReindex(), jobId, status, startedAt: new Date().toISOString() },
    }),
  );
}

export async function updateGuideReindexStatus(status: string) {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.guideReindex(),
      UpdateExpression: "SET #s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": status },
    }),
  );
}

// ---------- Timeline ----------

export async function recordTimelineEvent(input: {
  participantId: string;
  event: TimelineEvent;
  channel?: string;
  refId?: string;
  labStep: string;
}): Promise<TimelineItem> {
  const id = ulid();
  const k = keys.timeline(id);
  const item: TimelineItem = {
    ...k,
    participantId: input.participantId,
    event: input.event,
    channel: input.channel,
    refId: input.refId,
    labStep: input.labStep,
    createdAt: isoFromUlid(id),
  };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

export async function listTimeline(): Promise<TimelineItem[]> {
  // One event per login/question/upload/resolve/ai_query — easily thousands of rows across a
  // 500-participant, 3-day workshop, all in the single `WORKSHOP` partition. queryAll pages
  // through LastEvaluatedKey so that doesn't silently truncate at DynamoDB's 1MB page cap.
  return queryAll<TimelineItem>({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": "WORKSHOP", ":prefix": "EVT#" },
    ScanIndexForward: true,
  });
}

// ---------- AI daily quota ----------

const AI_DAILY_QUOTA = Number(process.env.AI_DAILY_QUOTA ?? 30);

/** Returns true and increments the counter if the participant is still under quota today. */
export async function tryConsumeAiQuota(participantId: string): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const key = { pk: `USER#${participantId}`, sk: `QUOTA#${day}` };
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: key,
      UpdateExpression: "ADD #c :one",
      ExpressionAttributeNames: { "#c": "count" },
      ExpressionAttributeValues: { ":one": 1 },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  return (res.Attributes?.count ?? 0) <= AI_DAILY_QUOTA;
}

// ---------- Lab step ----------

export async function getLabStep(): Promise<string> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.labStep() }));
  return res.Item?.step ?? "intro";
}

export async function setLabStep(step: string) {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...keys.labStep(), step, updatedAt: new Date().toISOString() },
    }),
  );
}
