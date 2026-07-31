import { ulid, decodeTime } from "ulid";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./client.js";
import {
  TABLE_NAME,
  keys,
  padUpvotes,
  type MessageItem,
  type ParticipantItem,
  type AiQueryItem,
  type TimelineItem,
  type QuestionStatus,
  type MessageKind,
  type TimelineEvent,
} from "./model.js";

function isoFromUlid(id: string): string {
  return new Date(decodeTime(id)).toISOString();
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
}) {
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
  return item;
}

export async function listMessages(channel: string, limit = 100) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `CHANNEL#${channel}`, ":prefix": "MSG#" },
      ScanIndexForward: true,
      Limit: limit,
    }),
  );
  return res.Items ?? [];
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

export async function upvoteQuestion(channel: string, messageUlid: string) {
  // read-modify-write on both the message and its status-index projection: the index's SK
  // embeds the upvote count so it must be rewritten, not just ADD-ed, when it moves buckets.
  const msgKey = keys.message(channel, messageUlid);
  const cur = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: msgKey }));
  if (!cur.Item) throw new Error("message not found");
  const newUpvotes = (cur.Item.upvotes ?? 0) + 1;
  const status: QuestionStatus = cur.Item.status ?? "open";

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: msgKey,
      UpdateExpression: "SET upvotes = :v",
      ExpressionAttributeValues: { ":v": newUpvotes },
    }),
  );

  // delete old index item, write new one at the new upvote bucket
  const oldKey = keys.questionIndex(status, newUpvotes - 1, messageUlid);
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
  return newUpvotes;
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
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `QSTATUS#${status}` },
      ScanIndexForward: false, // highest upvotes first
    }),
  );
  return (res.Items ?? []).filter((i) => i.messageId);
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
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
  const res = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "sk = :meta AND begins_with(pk, :prefix)",
      ExpressionAttributeValues: { ":meta": "META", ":prefix": "USER#" },
    }),
  );
  return (res.Items ?? []) as ParticipantItem[];
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
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `USER#${participantId}`, ":prefix": "AI#" },
    }),
  );
  return (res.Items ?? []) as AiQueryItem[];
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
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": "WORKSHOP", ":prefix": "EVT#" },
      ScanIndexForward: true,
    }),
  );
  return (res.Items ?? []) as TimelineItem[];
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
