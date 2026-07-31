# Data Model

Single DynamoDB table `WorkshopChat` (on-demand capacity). The §8 Excel export is a fixed
contract; every key here exists to serve one of the four sheets with a single query.

## Table: WorkshopChat

| Entity | PK | SK | Notable attributes |
|---|---|---|---|
| Channel | `CHANNEL#<slug>` | `META` | `name`, `archived`, `scaleVisible` |
| Message | `CHANNEL#<slug>` | `MSG#<ulid>` | `participantId`, `body`, `kind` (`msg`\|`question`), `threadId?`, `labStep`, `upvotes`, `status` (`open`\|`resolved`, questions only), `deleted`, `media[]` |
| Thread reply | `THREAD#<rootUlid>` | `MSG#<ulid>` | same shape as Message |
| Question status index (denormalized) | `QSTATUS#open` \| `QSTATUS#resolved` | `<upvotesPadded>#<ulid>` | `body`, `channel`, `labStep`, `resolvedAt?`, `responder?` — written alongside every question Message so the operator "unresolved" view and large-mode upvote sort are one query |
| Participant | `USER#<participantId>` | `META` | `displayName`, `pwHash`, `questionCount`, `aiQueryCount`, `firstSeen`, `lastSeen`, `blocked` |
| AI query | `USER#<participantId>` | `AI#<ulid>` | `query`, `refDocs[]`, `answerSummary`, `feedback` (`up`\|`down`\|null), `labStep`, `tokensIn`, `tokensOut` |
| Timeline event | `USER#<participantId>` | `EVT#<ulid>` | `event` (`login`\|`upload`\|`question`\|`resolve`\|`ai_query`), `channel?`, `refId?`, `labStep` |
| Lab step (singleton) | `WORKSHOP` | `LABSTEP` | `step`, `updatedAt` |
| Export state (singleton) | `WORKSHOP` | `EXPORT` | `lastExportAt`, `s3Key` |

### No secondary indexes

`QSTATUS#<open|resolved>` and `WORKSHOP` are already distinct **base-table partition keys** —
single-table design gives "one query per export sheet" for free, so no GSI is needed:

- Question status/upvote ordering: `Query pk = QSTATUS#<status>`, SK `<upvotesPadded>#<ulid>`
  (upvotes zero-padded to 4 digits so lexical sort == numeric sort), sorted descending. Serves
  both the operator's unresolved filter and, in `scale=large` mode, the upvote-ordered Q&A board.
- Timeline: `Query pk = WORKSHOP, sk begins_with EVT#`. One time-ordered scan of a single
  partition.

A GSI would only earn its cost if these needed to be queried by some *other* attribute than the
one that's already the partition key — that need doesn't exist here.

ULIDs are lexically time-sortable, so a row's timestamp is decoded from its ULID and never
stored as a separate attribute.

Upvotes are a plain `ADD upvotes :1` update — eventually consistent is fine per spec §9, which
explicitly waives strong consistency at this scale.

A participant is "silent" (Participants sheet) when `questionCount == 0 && aiQueryCount == 0`.

## Sheet → query mapping

| Sheet (§8.2) | Query |
|---|---|
| `Questions` | GSI1, both `QSTATUS#open` and `QSTATUS#resolved` partitions |
| `AI_Queries` | For each `USER#*`, query SK prefix `AI#` |
| `Participants` | Query PK prefix `USER#`, SK `= META` |
| `Timeline` | GSI2, single partition `WORKSHOP`, SK prefix `EVT#` |

Column rename from spec: `accountId` → **`participantId`** everywhere in the export. Identities
here are synthetic 12-digit IDs generated at deploy time (see §14-3 decision in the plan) — they
resemble AWS account IDs but map to no real account, so the export never contains one.

## Local development

`docker-compose.yml` runs `amazon/dynamodb-local` alongside the app so every table/GSI above can
be exercised offline. `app/src/db/model.ts` is the single source of truth for key construction —
nothing else in the codebase builds a PK/SK string by hand.
