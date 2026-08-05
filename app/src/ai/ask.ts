// §6.3 AI chat: Bedrock Retrieve (Knowledge Base, backed by S3 Vectors) + Converse, with a
// bounded tool-use loop against the keyless AWS Knowledge MCP Server (aws-knowledge-mcp.ts) so
// general AWS questions the lab guide doesn't cover can still be answered from real AWS docs
// instead of refusing.
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
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type Message as BedrockMessage,
  type ContentBlock,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { recordAiQuery } from "../db/repo.js";
import { searchAwsDocs, readAwsDoc } from "./aws-knowledge-mcp.js";

const KB_ID = process.env.BEDROCK_KB_ID;
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "";
const GUIDE_BUCKET = process.env.GUIDE_BUCKET;
const GUIDE_LOCAL_DIR = process.env.GUIDE_LOCAL_DIR; // docker-compose dev: mounted guide/ folder
const GUIDE_INJECT_MAX_CHARS = 60_000; // ~15k tokens; documented cap for the fallback path

// GUIDE_BUCKET can live in a different region than this task when a Bedrock Knowledge Base is
// enabled (the KB's S3 data source must be co-located with the KB — see infra/lib/bedrock-stack.ts)
// — explicit region avoids a PermanentRedirect from the SDK defaulting to this task's own region.
const s3 = new S3Client({ region: process.env.GUIDE_BUCKET_REGION });
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

const kbClient = new BedrockAgentRuntimeClient({ region: process.env.BEDROCK_REGION });
const converseClient = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION });

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
    // Filename only — the full s3:// URI leaks the guide bucket's name to end users.
    source: r.location?.s3Location?.uri?.split("/").pop() ?? "unknown",
  }));
}

// Two read-only tools backed by the AWS Knowledge MCP Server (aws-knowledge-mcp.ts) — enough
// for "look this up in real AWS docs" without pulling in AgentCore Gateway or a general web
// search tool, which need real IAM/network setup this disposable workshop stack doesn't have.
const TOOLS: Tool[] = [
  {
    toolSpec: {
      name: "search_aws_docs",
      description:
        "Search official AWS documentation. Use this for any AWS service/API/CLI/SDK question " +
        "the lab guide excerpts above don't already answer.",
      inputSchema: { json: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    },
  },
  {
    toolSpec: {
      name: "read_aws_doc",
      description: "Fetch the full text of an AWS documentation page. Use a URL returned by search_aws_docs.",
      inputSchema: { json: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    },
  },
];

async function runTool(name: string, input: any): Promise<string> {
  try {
    if (name === "search_aws_docs") return await searchAwsDocs(input.query);
    if (name === "read_aws_doc") return await readAwsDoc(input.url);
    return `unknown tool: ${name}`;
  } catch (err: any) {
    return `tool error: ${err.message}`;
  }
}

const MAX_TOOL_ROUNDS = 3; // bounds latency/cost; the last round always returns its text even if it still wants a tool

/** One ConverseStream call, reconstructing the full content-block array from stream events so
 * it can be fed back into `messages` for the next round of the tool-use loop. */
async function converseStreamRound(
  systemPrompt: string,
  messages: BedrockMessage[],
  onDelta?: (chunk: string) => void,
): Promise<{ content: ContentBlock[]; stopReason: string; tokensIn: number; tokensOut: number }> {
  const res = await converseClient.send(
    new ConverseStreamCommand({ modelId: MODEL_ID, system: [{ text: systemPrompt }], messages, toolConfig: { tools: TOOLS } }),
  );
  const blocks: Array<{ text?: string; toolUse?: { toolUseId: string; name: string; inputJson: string } }> = [];
  let stopReason = "";
  let tokensIn = 0;
  let tokensOut = 0;

  for await (const event of res.stream ?? []) {
    if (event.contentBlockStart) {
      const { contentBlockIndex, start } = event.contentBlockStart;
      blocks[contentBlockIndex!] = start?.toolUse
        ? { toolUse: { toolUseId: start.toolUse.toolUseId!, name: start.toolUse.name!, inputJson: "" } }
        : { text: "" };
    } else if (event.contentBlockDelta) {
      const { contentBlockIndex, delta } = event.contentBlockDelta;
      const block = blocks[contentBlockIndex!] ?? (blocks[contentBlockIndex!] = { text: "" });
      if (delta?.text) {
        block.text = (block.text ?? "") + delta.text;
        onDelta?.(delta.text);
      } else if (delta?.toolUse?.input && block.toolUse) {
        block.toolUse.inputJson += delta.toolUse.input;
      }
    } else if (event.messageStop) {
      stopReason = event.messageStop.stopReason ?? "";
    } else if (event.metadata?.usage) {
      tokensIn = event.metadata.usage.inputTokens ?? 0;
      tokensOut = event.metadata.usage.outputTokens ?? 0;
    }
  }

  // A block that started as text but received zero delta bytes (common right before the model
  // switches to a tool call) reconstructs as {text: ""} — Bedrock rejects an empty text block if
  // this turn gets replayed into the next round's `messages`, so drop it rather than keep it.
  const content: ContentBlock[] = blocks
    .filter((b) => b.toolUse || (b.text ?? "") !== "")
    .map((b) =>
      b.toolUse
        ? { toolUse: { toolUseId: b.toolUse.toolUseId, name: b.toolUse.name, input: JSON.parse(b.toolUse.inputJson || "{}") } }
        : { text: b.text ?? "" },
    );
  return { content, stopReason, tokensIn, tokensOut };
}

async function runWithTools(
  systemPrompt: string,
  userQuery: string,
  onDelta?: (chunk: string) => void,
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const messages: BedrockMessage[] = [{ role: "user", content: [{ text: userQuery }] }];
  let tokensIn = 0;
  let tokensOut = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await converseStreamRound(systemPrompt, messages, onDelta);
    tokensIn += result.tokensIn;
    tokensOut += result.tokensOut;

    const roundText = result.content.map((c) => ("text" in c ? c.text ?? "" : "")).join("");
    if (result.stopReason !== "tool_use" || round === MAX_TOOL_ROUNDS - 1) {
      return { text: roundText, tokensIn, tokensOut };
    }

    // A round that calls a tool often has a short preamble ("let me check...") before the
    // toolUse block. The NEXT round's answer starts a fresh line of markdown (often a heading),
    // and without a separator the two rounds' streamed text glues onto one line — CommonMark
    // only recognizes `## heading` at the start of a line, so it renders as literal text instead.
    if (roundText && onDelta) onDelta("\n\n");

    messages.push({ role: "assistant", content: result.content });
    const toolResults: ContentBlock[] = await Promise.all(
      result.content
        .filter((c): c is ContentBlock.ToolUseMember => "toolUse" in c && !!c.toolUse)
        .map(async (c) => ({
          toolResult: { toolUseId: c.toolUse.toolUseId, content: [{ text: await runTool(c.toolUse.name!, c.toolUse.input) }] },
        })),
    );
    messages.push({ role: "user", content: toolResults });
  }
  // unreachable: the round === MAX_TOOL_ROUNDS - 1 check above always returns first
  return { text: "", tokensIn, tokensOut };
}

async function defaultConverse(systemPrompt: string, userQuery: string) {
  return runWithTools(systemPrompt, userQuery);
}

async function defaultConverseStream(systemPrompt: string, userQuery: string, onDelta: (chunk: string) => void) {
  return runWithTools(systemPrompt, userQuery, onDelta);
}

export const defaultDeps: AskDeps = {
  retrieve: defaultRetrieve,
  converse: defaultConverse,
  converseStream: defaultConverseStream,
  loadGuide: loadGuideText,
};

// The UI renders full GFM Markdown (headings, lists, tables, blockquotes) plus fenced
// ```mermaid code blocks as an actual diagram — worth using whenever they make an answer
// clearer, not just when explicitly asked.
const FORMATTING_NOTE =
  "For AWS service/API questions where you want to confirm current, authoritative details, " +
  "use the search_aws_docs / read_aws_doc tools. The chat UI renders full Markdown — use " +
  "tables for structured comparisons and fenced ```mermaid code blocks for diagrams " +
  "(architecture, sequence, flowcharts) whenever they'd help.";

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
      `when it didn't. ${FORMATTING_NOTE}\n\n` +
      (passages.length ? passages.map((p, i) => `[${i + 1}] (${p.source})\n${p.text}`).join("\n\n") : "(no relevant excerpts found)");
    return { systemPrompt, refDocs: [...new Set(passages.map((p) => p.source))] };
  }
  const guide = (await deps.loadGuide()).slice(0, GUIDE_INJECT_MAX_CHARS);
  const systemPrompt =
    "You are a workshop lab assistant. Prefer the lab guide below when it's relevant to the " +
    "question. If it doesn't cover the question, answer normally from your own knowledge " +
    "instead of refusing — just don't imply an answer came from the lab guide when it " +
    `didn't. ${FORMATTING_NOTE}\n\n` + guide;
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
