// Thin fetch wrapper. Session is a cookie (see app/src/auth/session.ts), so every call just
// needs credentials: "include" — no token to attach by hand.

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
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
  status?: "open" | "resolved";
  deleted: boolean;
  media: string[];
  createdAt: string;
}

export interface Channel {
  pk: string;
  sk: string;
  name: string;
  archived: boolean;
  scaleVisible: boolean;
}

export const api = {
  session: () => req<{ session: Session | null }>("/api/session"),
  loginPassphrase: (participantId: string, passphrase: string) =>
    req("/api/login/passphrase", { method: "POST", body: JSON.stringify({ participantId, passphrase }) }),
  loginPassword: (participantId: string, password: string) =>
    req("/api/login/password", { method: "POST", body: JSON.stringify({ participantId, password }) }),
  loginOperator: (passcode: string) => req("/api/login/operator", { method: "POST", body: JSON.stringify({ passcode }) }),
  logout: () => req("/api/logout", { method: "POST" }),

  channels: () => req<{ channels: Channel[] }>("/api/channels"),
  messages: (slug: string) => req<{ messages: Message[] }>(`/api/channels/${slug}/messages`),
  threadReplies: (rootUlid: string) => req<{ replies: Message[] }>(`/api/threads/${rootUlid}`),
  postMessage: (slug: string, body: string, kind: "msg" | "question", threadId?: string) =>
    req<{ message: Message }>(`/api/channels/${slug}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, kind, threadId }),
    }),
  upvote: (slug: string, ulid: string) =>
    req<{ upvotes: number }>(`/api/channels/${slug}/messages/${ulid}/upvote`, { method: "POST" }),
  resolve: (slug: string, ulid: string) =>
    req(`/api/channels/${slug}/messages/${ulid}/resolve`, { method: "POST" }),
  deleteMessage: (slug: string, ulid: string) =>
    req(`/api/channels/${slug}/messages/${ulid}`, { method: "DELETE" }),
  questions: (status: "open" | "resolved") => req<{ questions: any[] }>(`/api/questions?status=${status}`),

  labStep: () => req<{ step: string }>("/api/labstep"),
  setLabStep: (step: string) => req("/api/labstep", { method: "POST", body: JSON.stringify({ step }) }),

  ask: (query: string) => req<{ answer: string; refDocs: string[] }>("/api/ai/ask", { method: "POST", body: JSON.stringify({ query }) }),

  participants: () => req<{ participants: any[] }>("/api/participants"),
  block: (id: string) => req(`/api/participants/${id}/block`, { method: "POST" }),
  unblock: (id: string) => req(`/api/participants/${id}/unblock`, { method: "POST" }),

  exportNow: () => req<{ s3Key: string; lastExportAt: string }>("/api/export/now", { method: "POST" }),
  exportStatus: () => req<{ lastExportAt: string | null }>("/api/export/status"),

  roster: () => req<{ roster: { participantId: string; joinUrl: string }[]; participantPassphrase: string }>(
    "/api/operator/roster",
  ),
};

export function wsUrl(channel: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws?channel=${channel}`;
}
