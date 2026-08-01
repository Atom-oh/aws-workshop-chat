# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A disposable Q&A/chat app for AWS workshops (10–500 participants, ~3 days). Deployed once into a
workshop's Central Account, destroyed with it when the workshop ends — its only permanent output
is one xlsx export downloaded before that happens. It exists to fix three Slack-workspace failure
modes: bulk-invite spam blocks, no cohort separation, and questions scrolling out of sight past
~50 participants. See `README.md` and `docs/DATA_MODEL.md` for full rationale — this file only
covers what a future session needs to move fast, not why every decision was made.

**Not** a permanently-hosted product, **not** tied to Workshop Studio's account-vending
(participants are synthetic 12-digit IDs, not real AWS accounts), **not** a video platform.

## Commands

npm workspaces monorepo (`app`, `infra`, `web`) — most commands run inside one workspace.

```bash
# Local dev loop (DynamoDB Local + app, no AWS account needed for chat/threads/upvotes/export)
docker compose up --build
# AI chat needs real AWS creds + BEDROCK_MODEL_ID exported on the host first; operator login
# needs a real Cognito user (Bedrock/Cognito have no local emulator).

# Backend (app/)
cd app
npm run dev              # tsx watch src/server.ts
npm run build            # tsc -p tsconfig.json
npm test                 # tsx --test test/*.test.ts — all 4 suites
npx tsx --test test/xlsx.test.ts                              # one suite
npx tsx --test --test-name-pattern="idempotent" test/*.test.ts # by test name

# Frontend (web/)
cd web
npm run dev              # vite dev server
npm run build             # vite build -> web/dist (served statically by the Fastify app)

# Infra (infra/)
cd infra
npm run synth             # cdk synth
npm run deploy             # cdk deploy — see README.md "Deploy" for the required --context flags
npm run destroy             # cdk destroy

# Root
npm test                  # delegates to app's test suite
npm run loadtest -- --clients 500   # WebSocket broadcast load test against a running instance
```

No workspace has a lint/format config — don't invent one. `npx tsc --noEmit` (from `app/` or
`web/`) is the fastest correctness check before running the full suite.

Every deploy rebuilds and pushes the container image automatically
(`ecs.ContainerImage.fromAsset`, arm64) — there is no separate `docker build`/`docker push` step.

## Architecture

### Three workspaces, one deploy unit

- `app/` — Fastify 5 server: REST API, static frontend host, in-process WebSocket hub. Single
  process, single ECS Fargate task (`desiredCount: 1`, pinned deliberately — see README's "Why a
  single Fargate task" section before ever proposing horizontal scaling here).
- `web/` — React 18 + Vite SPA, built to `web/dist/` and served by the same Fastify process
  (`app/src/server.ts` registers `@fastify/static` against `../../web/dist`).
- `infra/` — CDK v2 stack (`infra/lib/workshop-chat-stack.ts`) plus a second, separate stack
  (`infra/lib/waf-stack.ts`) that exists ONLY because CloudFront-scoped WAFv2 WebACLs can only be
  created via the `us-east-1` API endpoint regardless of where the main stack deploys — CDK
  cross-region references (`crossRegionReferences: true`) wire the two together.

### DynamoDB: one table, no GSIs

Single table `WorkshopChat`, on-demand capacity. Every access pattern is served by the base
table's own partition key (`CHANNEL#slug`, `THREAD#rootUlid`, `QSTATUS#open|resolved`,
`USER#participantId`, `WORKSHOP`) — see `docs/DATA_MODEL.md` for the full key table and the
sheet→query mapping used by the xlsx export. `app/src/db/model.ts` is the single source of truth
for key construction; nothing else builds a PK/SK string by hand. `app/src/db/repo.ts`'s
`queryAll`/`scanAll` page through `LastEvaluatedKey` for every unbounded read (export, operator
views) — DynamoDB's 1MB-per-response cap is real at this table's largest partitions (Timeline,
any one channel's Messages), and a naive single Query/Scan silently truncates past it.

### Auth: two independent credential paths that happen to share one secret

- **Cognito-backed** (`app/src/auth/cognito.ts`): the operator account and the "individual
  password" login fallback. Role is determined by **Cognito group membership**
  (`AdminListGroupsForUser`, groups `admin`/`participant`), never by comparing a username string.
- **App-signed session tokens** (`app/src/auth/token.ts`, `app/src/auth/session.ts`): the
  one-click `/j` join link and the shared-passphrase fallback. These never touch Cognito at
  request time — no IdP round-trip for a disposable 3-day app.

Both paths derive from the same `CredentialSeed` secret (Secrets Manager): the
credentials-provisioner Lambda (`infra/lambda/credentials-handler.ts`) uses it to derive every
participant's Cognito ID/password, and the app container reuses the identical value as its
session-token signing secret — so the operator console can re-derive any participant's ID and
mint their join link on demand, with no separate roster to keep in sync.

**CloudFormation gotcha that bit this twice:** dynamic references
(`{{resolve:secretsmanager:...}}`) are NOT resolved inside Custom Resource properties — passing
`secret.secretValue.unsafeUnwrap()` into a `CustomResource`'s `properties` hands the Lambda the
literal unresolved token string, not the real value. The stack passes secret **ARNs** instead;
`credentials-handler.ts` fetches the real values itself via `GetSecretValueCommand`.

### AI chat: retrieval + optional tool-use loop, always streamed

`app/src/ai/ask.ts` is the whole pipeline:

1. **Context**: Bedrock Knowledge Base `Retrieve` (S3 Vectors) if `BEDROCK_KB_ID` is set,
   otherwise the whole lab guide is injected into the system prompt (fallback for regions without
   S3 Vectors, capped at ~60k chars, cache invalidated by the guide-doc management routes).
2. **Generation**: always `ConverseStreamCommand`, never the non-streaming `Converse` — even the
   non-streaming `ask()` entry point reuses the same streaming path internally and just discards
   deltas, so there is one code path to maintain, not two.
3. **Tool use** (`TOOLS` in `ask.ts`): the model can call `search_aws_docs`/`read_aws_doc`, backed
   by `app/src/ai/aws-knowledge-mcp.ts` — a hand-rolled JSON-RPC client (no MCP SDK dependency)
   against `https://knowledge-mcp.global.api.aws`, AWS's keyless, fully-managed public MCP server
   (GA Oct 2025). Bounded to `MAX_TOOL_ROUNDS` rounds. Reconstructing content blocks from
   `ConverseStream` events must drop empty `{text: ""}` blocks before replaying them into the next
   round's `messages` — Bedrock rejects an empty text block, and the model reliably produces one
   right before switching to a tool call.
4. **Route**: `POST /api/ai/ask/stream` (`app/src/routes/ai.ts`) uses `reply.hijack()` +
   `reply.raw` to speak raw Server-Sent Events, bypassing Fastify's normal reply lifecycle.

IAM note: `ConverseStream`/`InvokeModelWithResponseStream` is a **separate** IAM action from
`InvokeModel` — granting only the latter breaks streaming with an opaque AccessDenied.

### Frontend: shared dark-theme components, no CSS framework

`web/src/theme.ts` (color constants) and `web/src/Composer.tsx` (the message input — Enter to
send, Shift+Enter for a newline, guarded by `e.nativeEvent.isComposing` so Korean/Japanese/Chinese
IME composition doesn't fire a premature send) are shared by `Chat.tsx` (participant view) and
`Operator.tsx` (operator console) to keep the two visually and behaviorally consistent.
`web/src/Markdown.tsx` renders full GFM markdown (`react-markdown` + `remark-gfm`) with one
custom rule: a fenced ` ```mermaid ` block renders as an actual diagram
(`web/src/Mermaid.tsx`) instead of a code block. `mermaid` is dynamically `import()`ed only when
a mermaid block actually appears — a static import balloons the main bundle from ~200KB to ~1MB
because it bundles a renderer per diagram type.

File attachments (`web/src/Attachment.tsx`, `web/src/media.ts`): the media S3 bucket is private,
so every render/download goes through a fresh short-lived presigned GET
(`GET /api/media/url`) rather than a stored URL. The filename rides inside the S3 key itself
(`media/<participantId>/<uuid>__<filename>`) — no separate metadata store.

### Region/model caveats worth knowing before touching `infra/` or `ask.ts`

- Many regions (`ap-northeast-2` included) expose Claude models only as `INFERENCE_PROFILE`, not
  `ON_DEMAND` — check with `aws bedrock get-foundation-model --model-identifier <id> --query
  modelDetails.inferenceTypesSupported` before hardcoding a model ID anywhere.
- S3 Vectors isn't available in every region; `enableKnowledgeBase=false` at deploy time switches
  to the prompt-injection fallback described above.
