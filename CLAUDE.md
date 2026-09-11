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

## Language policy

- Write everything you author into a file — code, comments, commit messages, docs, this file
  itself — in English. This is a non-ASCII-encoding safety rule as much as a style one: this
  session already lost time to a real mojibake bug (an uploaded HTML attachment's Korean text
  rendered garbled because of a missing charset, see `GET /api/media/html` in
  `app/src/routes/upload.ts`) — keep authored file content ASCII-only to avoid adding more
  surface for that class of bug.
- This does **not** apply to the app's own Korean-language content that exists on purpose —
  UI copy (`web/src/i18n.tsx`), the lab guide under `guide/`, or any string a participant/operator
  actually sees in the product. Only what *you* write when not asked to write Korean product
  content.
- Talk to the user in Korean (한국어) in chat — this rule is about file content, not
  conversation.

## Commands

npm workspaces monorepo (`app`, `infra`, `web`) — most commands run inside one workspace.

```bash
# Local dev loop (nickname participants + DynamoDB Local; no AWS account for chat/threads/upvotes)
docker compose up --build
# Compose defaults PARTICIPANT_AUTH_MODE to nickname; backend/CDK default to cognito.
# Operator login needs a real Cognito pool/client/admin user and AWS credentials passed into
# the container; AI chat also needs real AWS credentials + BEDROCK_MODEL_ID.

# Backend (app/)
cd app
npm run dev              # tsx watch src/server.ts
npm run build            # tsc -p tsconfig.json
npm test                 # tsx --test test/*.test.ts — all 5 suites
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
npx tsc --noEmit
node --import tsx --test test/participant-auth-mode.test.ts # offline auth-mode synth/assertions

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
- `infra/` — CDK v2, three stacks wired together via `crossRegionReferences: true`
  (`infra/bin/app.ts`), each pinned to whichever region its AWS API actually requires:
  - `workshop-chat-stack.ts` — everything else (ECS, ALB, CloudFront, DynamoDB, Cognito), in the
    CLI's resolved region.
  - `waf-stack.ts` — pinned to `us-east-1` because CloudFront-scoped WAFv2 WebACLs can only be
    created via that region's API endpoint, regardless of where the main stack deploys.
  - `bedrock-stack.ts` — the Knowledge Base, S3 Vectors, and (when the KB is enabled) the guide
    bucket itself, since a KB's S3 data source must share the KB's region. Pinned to
    `--context bedrockRegion` (defaults to the main stack's region) for environments — an AWS
    Workshop Studio participant account, for example — where Bedrock is only available in one
    specific region (usually `us-east-1`) while the rest of the app deploys nearer participants.
    Skipped entirely when `enableKnowledgeBase=false`.

### DynamoDB: one table, no GSIs

Single table `WorkshopChat`, on-demand capacity. Every access pattern is served by the base
table's own partition key (`CHANNEL#slug`, `THREAD#rootUlid`, `QSTATUS#open|resolved`,
`USER#participantId`, `WORKSHOP`) — see `docs/DATA_MODEL.md` for the full key table and the
sheet→query mapping used by the xlsx export. `app/src/db/model.ts` is the single source of truth
for key construction; nothing else builds a PK/SK string by hand. `app/src/db/repo.ts`'s
`queryAll`/`scanAll` page through `LastEvaluatedKey` for every unbounded read (export, operator
views) — DynamoDB's 1MB-per-response cap is real at this table's largest partitions (Timeline,
any one channel's Messages), and a naive single Query/Scan silently truncates past it.

### Auth: participant mode selection, Cognito operators, app-signed sessions

`PARTICIPANT_AUTH_MODE` accepts only `cognito` or `nickname`; backend/CDK default to `cognito`.
`infra/bin/app.ts` resolves explicit `--context participantAuthMode` first, then the environment,
then that default, and rejects unsupported values before creating stacks. It passes the mode
through `WorkshopChatStackProps` into the ECS environment. The backend also validates its
runtime configuration. Docker Compose explicitly defaults to `nickname` for local participant
entry without an AWS account.

- **Cognito participant mode:** ID/password login (`POST /api/login/id`, `app/src/auth/cognito.ts`)
  and individually signed `/j?t=<token>` join links. Cognito group membership determines role
  (`AdminListGroupsForUser`, `admin`/`participant`), never the username string.
- **Nickname participant mode:** everyone shares the public app link and enters a display
  nickname. The app creates an anonymous participant identity and signs its session cookie.
  Reloading preserves the current identity while that session is valid; logout, cookie
  removal/expiry, or a new browser creates a new identity on the next join, even with the same
  nickname. A nickname is not a recovery credential.
- **Operators in both modes:** sign in at `/operator` with Cognito credentials and `admin`
  group membership. Nickname entry never grants operator access.

The Cognito pool/client/groups, secrets, credentials provider, and operator account remain in
both modes. Nickname mode changes only the credentials Custom Resource's `ParticipantCount`
to `0`, skipping participant provisioning without deleting existing users. Keep the task's
`PARTICIPANT_COUNT` at the anticipated headcount. Nickname rosters use actual app registrants
against that target and a shared public link, not synthetic rows or pre-issued credentials;
the target is not an admission limit. Preserve construct IDs when changing modes.

CDK sets `PUBLIC_APP_URL` on the container after calculating `appHostname`: always
`https://${appHostname}`, using the configured custom domain or CloudFront domain. The nickname
roster uses this value for share links. Local requests fall back to their protocol/host when
it is unset; behind CloudFront/ALB that fallback would otherwise see HTTP with `trustProxy=false`.

`participantPassphrase` remains a required CDK context option for compatibility, unrelated to
mode selection. There is no passphrase login. Keep it and the other normal deploy options in
nickname deployment commands (see README).

The `CredentialSeed` secret (Secrets Manager) derives Cognito participant credentials in
`infra/lambda/credentials-handler.ts` and signs app sessions in both modes
(`app/src/auth/token.ts`, `app/src/auth/session.ts`). In Cognito mode the operator can re-derive
participant IDs and mint join links without maintaining a separate roster.

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

File attachments (`web/src/Attachment.tsx`, `web/src/media.tsx`): the media S3 bucket is private,
so every render/download goes through a fresh short-lived presigned GET
(`GET /api/media/url`) rather than a stored URL. The filename rides inside the S3 key itself
(`media/<participantId>/<uuid>__<filename>`) — no separate metadata store. Images and PDFs
preview inline using that presigned URL directly. HTML attachments preview differently, through
a same-origin proxy (`GET /api/media/html`, `app/src/routes/upload.ts`) instead: the media
bucket's CORS policy only allows `PUT` (for uploads), so a client-side `fetch()` of the presigned
URL is CORS-blocked, and S3 stores whatever charset-less `Content-Type` the uploader's browser
guessed, which mangles non-ASCII text in this Korean-first app if rendered as-is. The proxy
route decodes as UTF-8 and forces the charset itself. That route must never be linked to
directly — only ever set as the `sandbox=""` iframe's `src` in `Attachment.tsx` — since (unlike
the cross-origin S3 URL) a direct top-level hit would run in the app's own origin with the
viewer's session cookie; it sends `Content-Security-Policy: sandbox` as defense-in-depth against
exactly that.

### Region/model caveats worth knowing before touching `infra/` or `ask.ts`

- Many regions (`ap-northeast-2` included) expose Claude models only as `INFERENCE_PROFILE`, not
  `ON_DEMAND` — check with `aws bedrock get-foundation-model --model-identifier <id> --query
  modelDetails.inferenceTypesSupported` before hardcoding a model ID anywhere.
- S3 Vectors isn't available in every region; `enableKnowledgeBase=false` at deploy time switches
  to the prompt-injection fallback described above.

### Guide-doc Content-Type

`app/src/guide-content-type.ts` derives Content-Type from the filename extension and is shared by
both the operator's upload route and `ai/reindex-retry.ts` — a browser's `File.type` sniff and
S3's no-Content-Type default (`binary/octet-stream`) are both unreliable, and Bedrock's Knowledge
Base ingestion silently skips text-based docs it can't identify. Any new code path that writes to
the guide bucket must go through this helper rather than trusting a caller-supplied content type.

### Don't resurrect the SSM/Organizations design

`docs/ssm-integration.md` documents a central-poller + AWS Organizations + cross-account
`AssumeRole` design from the original spec (`docs/SPEC-workshop-chat.md` §5) — **explicitly not
implemented**. Cognito mode derives synthetic participant IDs locally
(`app/src/auth/credentials.ts`) and distributes individual join links through the operator
console (`GET /api/operator/roster`) or `scripts/gen-links.ts`. Nickname mode creates anonymous
identities when participants enter through the shared app link. Don't treat either historical
spec doc as describing current behavior; use this file for auth-mode behavior.
