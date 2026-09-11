# Data Model

Single DynamoDB table `WorkshopChat` (on-demand capacity). The §8 Excel export is a fixed
contract; every key here exists to serve one of the four sheets with a single query.

## Table: WorkshopChat

| Entity | PK | SK | Notable attributes |
|---|---|---|---|
| Channel | `CHANNEL#<slug>` | `META` | `name`, `archived`, `scaleVisible` |
| Message | `CHANNEL#<slug>` | `MSG#<ulid>` | `participantId`, `displayName?`, `body`, `kind` (`msg`\|`question`), `threadId?`, `labStep`, `upvotes`, `status` (`open`\|`resolved`, questions only), `deleted`, `media[]` |
| Thread reply | `THREAD#<rootUlid>` | `MSG#<ulid>` | same shape as Message |
| Question status index (denormalized) | `QSTATUS#open` \| `QSTATUS#resolved` | `<upvotesPadded>#<ulid>` | `body`, `channel`, `labStep`, `resolvedAt?`, `responder?` — written alongside every question Message so the operator "unresolved" view and large-mode upvote sort are one query |
| Participant | `USER#<participantId>` | `META` | `displayName`, `authMode?` (`cognito`\|`nickname`; absent on legacy Cognito records), `pwHash`, `questionCount`, `aiQueryCount`, `firstSeen`, `lastSeen`, `blocked` |
| AI query | `USER#<participantId>` | `AI#<ulid>` | `displayName?`, `query`, `refDocs[]`, `answerSummary`, `feedback` (`up`\|`down`\|null), `labStep`, `tokensIn`, `tokensOut` |
| Timeline event | `WORKSHOP` | `EVT#<ulid>` | `event` (`login`\|`upload`\|`question`\|`resolve`\|`ai_query`), `participantId`, `channel?`, `refId?`, `labStep` |
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

Nickname entry assigns a random `guest-<UUID>` ID independently of the display name. Names
may repeat; records, moderation and sessions remain keyed by the unique ID. Messages, replies
and AI queries copy the nickname from the signed session so history retains the chosen name.
Guest registration writes the participant and login event in one transaction before issuing
the cookie, so a storage failure cannot leave a partially registered attendee.
Participant lookups use strongly consistent reads to preserve identity on immediate login
retries and observe new moderation blocks. Rosters and attendance include the active auth
mode's participants, while exports retain historical records from both modes.

## Sheet → query mapping

| Sheet (§8.2) | Query |
|---|---|
| `Questions` | Query `pk = CHANNEL#<slug>` for each channel, filter `kind = question` (base table, no index) |
| `AI_Queries` | For each `USER#<participantId>`, query SK prefix `AI#` |
| `Participants` | Scan filtered to `sk = META AND begins_with(pk, USER#)` — see "No secondary indexes" above |
| `Timeline` | Query `pk = WORKSHOP`, SK prefix `EVT#` — single partition, no index |

Column rename from spec: `accountId` → **`participantId`** everywhere in the export. Cognito
identities are synthetic 12-digit IDs generated at deploy time; nickname identities use
`guest-<UUID>`. Neither maps to a real AWS account. The Participants sheet's existing
`displayName` column contains the chosen nickname for guests.

## Local development

`docker-compose.yml` runs `amazon/dynamodb-local` alongside the app so the whole table above can
be exercised offline. `app/src/db/model.ts` is the single source of truth for key construction —
nothing else in the codebase builds a PK/SK string by hand.

Every export/operator query pages through DynamoDB's `LastEvaluatedKey` in full (`queryAll`/
`scanAll` in `app/src/db/repo.ts`) rather than trusting a single Query/Scan response — that
response caps at 1MB regardless of `Limit`, and this table's largest partitions (`WORKSHOP`'s
Timeline rows, and any one channel's Messages) can exceed it well before item counts look large.
