// §6.3 AI chat: Bedrock Retrieve (Knowledge Base, backed by S3 Vectors) + Converse.
// No AgentCore Runtime, no agent loop — answering from a static lab guide needs no tool use.
//
// Region fallback: if BEDROCK_KB_ID is unset (KB/S3 Vectors unavailable in this region, or the
// operator chose the prompt-injection path), the whole guide is stuffed into the system prompt
// instead of retrieved. The resolution is logged once at startup, per the plan.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { recordAiQuery } from "../db/repo.js";

const KB_ID = process.env.BEDROCK_KB_ID;
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "";
const GUIDE_BUCKET = process.env.GUIDE_BUCKET;
const GUIDE_LOCAL_DIR = process.env.GUIDE_LOCAL_DIR; // docker-compose dev: mounted guide/ folder
const GUIDE_INJECT_MAX_CHARS = 60_000; // ~15k tokens; documented cap for the fallback path

const s3 = new S3Client({});
let cachedGuideText: string | null = null;

/**
 * Loads the whole lab guide once per process for the prompt-injection fallback path. The guide
 * doesn't change mid-workshop, so a process-lifetime cache is enough — a restart (or a fresh
 * deploy) picks up any re-uploaded content.
 */
async function loadGuideText(): Promise<string> {
  if (cachedGuideText !== null) return cachedGuideText;

  if (GUIDE_LOCAL_DIR) {
    const files = await readdir(GUIDE_LOCAL_DIR).catch(() => []);
    const parts = await Promise.all(
      files.filter((f) => f.endsWith(".md")).map((f) => readFile(path.join(GUIDE_LOCAL_DIR, f), "utf8")),
    );
    cachedGuideText = parts.join("\n\n");
  } else if (GUIDE_BUCKET) {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: GUIDE_BUCKET, Prefix: "guide/" }));
    const keys = (listed.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k?.endsWith(".md"));
    const parts = await Promise.all(
      keys.map(async (Key) => {
        const obj = await s3.send(new GetObjectCommand({ Bucket: GUIDE_BUCKET, Key }));
        return (await obj.Body?.transformToString()) ?? "";
      }),
    );
    cachedGuideText = parts.join("\n\n");
  } else {
    cachedGuideText = "";
  }
  return cachedGuideText;
}

/** Called by the guide-doc management routes after an upload/toggle/delete so the fallback
 * (no-KB) path picks up the change without a full container restart. */
export function invalidateGuideCache() {
  cachedGuideText = null;
}

if (!MODEL_ID) {
  // deploy-time parameter, never hardcoded (§10) — fail loudly rather than silently picking one
  console.warn("[ai] BEDROCK_MODEL_ID is not set; AI chat will error on first use");
}
console.log(`[ai] context mode: ${KB_ID ? `knowledge-base (${KB_ID})` : "prompt-injection fallback"}`);

const kbClient = new BedrockAgentRuntimeClient({});
const converseClient = new BedrockRuntimeClient({});

export interface RetrievedPassage {
  text: string;
  source: string;
}

export interface AskDeps {
  retrieve: (query: string) => Promise<RetrievedPassage[]>;
  converse: (systemPrompt: string, userQuery: string) => Promise<{ text: string; tokensIn: number; tokensOut: number }>;
  converseStream: (
    systemPrompt: string,
    userQuery: string,
    onDelta: (chunk: string) => void,
  ) => Promise<{ text: string; tokensIn: number; tokensOut: number }>;
  loadGuide: () => Promise<string>; // used only by the fallback path
}

async function defaultRetrieve(query: string): Promise<RetrievedPassage[]> {
  if (!KB_ID) return [];
  const res = await kbClient.send(
    new RetrieveCommand({
      knowledgeBaseId: KB_ID,
      retrievalQuery: { text: query },
      retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 5 } },
    }),
  );
  return (res.retrievalResults ?? []).map((r) => ({
    text: r.content?.text ?? "",
    source: r.location?.s3Location?.uri ?? "unknown",
  }));
}

async function defaultConverse(systemPrompt: string, userQuery: string) {
  const res = await converseClient.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: systemPrompt }],
      messages: [{ role: "user", content: [{ text: userQuery }] }],
    }),
  );
  const text = res.output?.message?.content?.[0]?.text ?? "";
  return {
    text,
    tokensIn: res.usage?.inputTokens ?? 0,
    tokensOut: res.usage?.outputTokens ?? 0,
  };
}

async function defaultConverseStream(
  systemPrompt: string,
  userQuery: string,
  onDelta: (chunk: string) => void,
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const res = await converseClient.send(
    new ConverseStreamCommand({
      modelId: MODEL_ID,
      system: [{ text: systemPrompt }],
      messages: [{ role: "user", content: [{ text: userQuery }] }],
    }),
  );
  let text = "";
  let tokensIn = 0;
  let tokensOut = 0;
  for await (const event of res.stream ?? []) {
    const delta = event.contentBlockDelta?.delta?.text;
    if (delta) {
      text += delta;
      onDelta(delta);
    }
    if (event.metadata?.usage) {
      tokensIn = event.metadata.usage.inputTokens ?? 0;
      tokensOut = event.metadata.usage.outputTokens ?? 0;
    }
  }
  return { text, tokensIn, tokensOut };
}

export const defaultDeps: AskDeps = {
  retrieve: defaultRetrieve,
  converse: defaultConverse,
  converseStream: defaultConverseStream,
  loadGuide: loadGuideText,
};

async function buildPrompt(
  query: string,
  deps: AskDeps,
): Promise<{ systemPrompt: string; refDocs: string[] }> {
  if (KB_ID) {
    const passages = await deps.retrieve(query);
    const systemPrompt =
      "You are a workshop lab assistant. Prefer the lab guide excerpts below when they're " +
      "relevant to the question. If they don't cover it, answer normally from your own " +
      "knowledge instead of refusing — just don't imply an answer came from the lab guide " +
      "when it didn't.\n\n" +
      (passages.length ? passages.map((p, i) => `[${i + 1}] (${p.source})\n${p.text}`).join("\n\n") : "(no relevant excerpts found)");
    return { systemPrompt, refDocs: passages.map((p) => p.source) };
  }
  const guide = (await deps.loadGuide()).slice(0, GUIDE_INJECT_MAX_CHARS);
  const systemPrompt =
    "You are a workshop lab assistant. Prefer the lab guide below when it's relevant to the " +
    "question. If it doesn't cover the question, answer normally from your own knowledge " +
    "instead of refusing — just don't imply an answer came from the lab guide when it " +
    "didn't.\n\n" + guide;
  return { systemPrompt, refDocs: ["lab-guide (injected)"] };
}

export async function ask(
  input: { participantId: string; query: string; labStep: string },
  deps: AskDeps = defaultDeps,
): Promise<{ answer: string; refDocs: string[]; aiUlid: string }> {
  const { systemPrompt, refDocs } = await buildPrompt(input.query, deps);
  const { text, tokensIn, tokensOut } = await deps.converse(systemPrompt, input.query);

  const item = await recordAiQuery({
    participantId: input.participantId,
    query: input.query,
    refDocs,
    answerSummary: text.slice(0, 500),
    labStep: input.labStep,
    tokensIn,
    tokensOut,
  });

  return { answer: text, refDocs, aiUlid: item.sk.replace("AI#", "") };
}

export async function askStream(
  input: { participantId: string; query: string; labStep: string },
  onDelta: (chunk: string) => void,
  deps: AskDeps = defaultDeps,
): Promise<{ answer: string; refDocs: string[]; aiUlid: string }> {
  const { systemPrompt, refDocs } = await buildPrompt(input.query, deps);
  const { text, tokensIn, tokensOut } = await deps.converseStream(systemPrompt, input.query, onDelta);

  const item = await recordAiQuery({
    participantId: input.participantId,
    query: input.query,
    refDocs,
    answerSummary: text.slice(0, 500),
    labStep: input.labStep,
    tokensIn,
    tokensOut,
  });

  return { answer: text, refDocs, aiUlid: item.sk.replace("AI#", "") };
}
