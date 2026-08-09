// Thin fetch wrapper. Session is a cookie (see app/src/auth/session.ts), so every call just
// needs credentials: "include" — no token to attach by hand.

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Fastify's default JSON body parser 400s on a request that declares
  // `Content-Type: application/json` but sends no body (FST_ERR_CTP_EMPTY_JSON_BODY) — every
  // body-less POST here (exportNow, upvote, resolve, block/unblock, guide-doc actions) hit that
  // until this stopped forcing the header on requests with nothing to parse.
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export interface Session {
  participantId: string;
  role: "participant" | "operator";
}

export interface Message {
  pk: string;
  sk: string;
  participantId: string;
  body: string;
  kind: "msg" | "question";
  channel: string;
  threadId?: string;
  labStep: string;
  upvotes: number;
  upvoterIds?: string[];
  status?: "open" | "resolved";
  deleted: boolean;
  media: string[];
  createdAt: string;
  replyCount?: number;
}

export interface Channel {
  pk: string;
  sk: string;
  name: string;
  archived: boolean;
  scaleVisible: boolean;
}

export interface AiQuery {
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

export interface GuideDoc {
  key: string;
  name: string;
  sizeBytes: number;
  active: boolean;
  lastModified: string | null;
  // Real per-document Knowledge Base status, counted from the vector index itself — Bedrock's
  // own document-tracking API can mark a doc "indexed" even when its write to the vector store
  // failed, so this comes from actually counting chunks (see app/src/ai/guide-index.ts).
  // undefined when the KB isn't enabled for this deployment (region fallback).
  indexStatus?: "indexing" | "indexed" | "retrying" | "failed" | "pending";
}

export interface NoShow {
  participantId: string;
  joinUrl: string;
}

export interface Attendance {
  expectedCount: number;
  joinedCount: number;
  noShowCount: number;
  noShows: NoShow[];
  // "cognito": the roster came from Cognito's participant group (production truth). "derived":
  // no Cognito user pool is configured for this deployment, so it's a local-dev placeholder
  // roster — the operator should not treat these numbers as the real headcount.
  source: "cognito" | "derived";
}

export interface Participant {
  participantId: string;
  questionCount: number;
  aiQueryCount: number;
  lastSeen: string;
  blocked: boolean;
}

export const api = {
  session: () => req<{ session: Session | null }>("/api/session"),
  // Single Cognito login for both participant and operator accounts — role comes back from
  // group membership server-side, not from which login form the user picked.
  loginId: (id: string, password: string) =>
    req("/api/login/id", { method: "POST", body: JSON.stringify({ id, password }) }),
  logout: () => req("/api/logout", { method: "POST" }),

  channels: () => req<{ channels: Channel[] }>("/api/channels"),
  messages: (slug: string, after?: string) =>
    req<{ messages: Message[] }>(`/api/channels/${slug}/messages${after ? `?after=${after}` : ""}`),
  threadReplies: (rootUlid: string) => req<{ replies: Message[] }>(`/api/threads/${rootUlid}`),
  postMessage: (slug: string, body: string, kind: "msg" | "question", threadId?: string, media?: string[]) =>
    req<{ message: Message }>(`/api/channels/${slug}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, kind, threadId, media }),
    }),
  upvote: (slug: string, ulid: string) =>
    req<{ upvotes: number; upvoted: boolean }>(`/api/channels/${slug}/messages/${ulid}/upvote`, { method: "POST" }),
  resolve: (slug: string, ulid: string) =>
    req(`/api/channels/${slug}/messages/${ulid}/resolve`, { method: "POST" }),
  deleteMessage: (slug: string, ulid: string) =>
    req(`/api/channels/${slug}/messages/${ulid}`, { method: "DELETE" }),
  questions: (status: "open" | "resolved") => req<{ questions: Message[] }>(`/api/questions?status=${status}`),

  labStep: () => req<{ step: string }>("/api/labstep"),
  setLabStep: (step: string) => req("/api/labstep", { method: "POST", body: JSON.stringify({ step }) }),

  ask: (query: string) => req<{ answer: string; refDocs: string[] }>("/api/ai/ask", { method: "POST", body: JSON.stringify({ query }) }),

  participants: () => req<{ participants: Participant[] }>("/api/participants"),
  block: (id: string) => req(`/api/participants/${id}/block`, { method: "POST" }),
  unblock: (id: string) => req(`/api/participants/${id}/unblock`, { method: "POST" }),

  exportNow: () =>
    req<{ s3Key: string; lastExportAt: string; rowCounts: Record<string, number> }>("/api/export/now", {
      method: "POST",
    }),
  exportStatus: () =>
    req<{ lastExportAt: string | null; rowCounts: Record<string, number> | null }>("/api/export/status"),

  roster: () => req<{
    roster: { participantId: string; joinUrl: string }[];
    source: "cognito" | "derived";
    participantPassphrase: string;
  }>("/api/operator/roster"),

  operatorLoginLink: () => req<{ loginUrl: string }>("/api/operator/login-link"),

  aiQueries: () => req<{ queries: AiQuery[] }>("/api/operator/ai-queries"),
  aiFeedback: (aiUlid: string, feedback: "up" | "down") =>
    req(`/api/ai/${aiUlid}/feedback`, { method: "POST", body: JSON.stringify({ feedback }) }),

  attendance: () => req<Attendance>("/api/operator/attendance"),

  guideDocs: () => req<{ docs: GuideDoc[] }>("/api/operator/guide-docs"),
  // contentType is decided server-side from the filename's extension (see routes/operator.ts) —
  // the browser's own File.type sniff is unreliable enough for .html/.md that trusting it here
  // used to produce silently-unindexable guide docs. The server's chosen value comes back so
  // the PUT below can match exactly what the presigned URL signed.
  presignGuideDoc: (filename: string, sizeBytes: number) =>
    req<{ url: string; key: string; contentType: string }>("/api/operator/guide-docs/presign", {
      method: "POST",
      body: JSON.stringify({ filename, sizeBytes }),
    }),
  markGuideDocUploaded: () => req("/api/operator/guide-docs/uploaded", { method: "POST" }),
  deleteGuideDoc: (key: string) => req(`/api/operator/guide-docs?key=${encodeURIComponent(key)}`, { method: "DELETE" }),
  toggleGuideDoc: (key: string) => req(`/api/operator/guide-docs/toggle?key=${encodeURIComponent(key)}`, { method: "POST" }),
  reindexGuideDocs: () => req<{ jobId: string; status: string }>("/api/operator/guide-docs/reindex", { method: "POST" }),
  reindexStatus: () =>
    req<{ status: string | null; startedAt?: string; attempt?: number; maxAttempts?: number; failedDocs?: string[]; nextRetryAt?: string | null }>(
      "/api/operator/guide-docs/reindex-status",
    ),
};

export const upload = {
  presign: (filename: string, contentType: string, sizeBytes: number) =>
    req<{ url: string; key: string }>("/api/uploads/presign", {
      method: "POST",
      body: JSON.stringify({ filename, contentType, sizeBytes }),
    }),
  downloadUrl: (key: string) => req<{ url: string }>(`/api/media/url?key=${encodeURIComponent(key)}`),
};

export function wsUrl(channel: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws?channel=${channel}`;
}
