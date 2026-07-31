import { useEffect, useMemo, useRef, useState } from "react";
import { api, upload, wsUrl, type Channel, type Message, type Session } from "./api";
import { avatarColor } from "./format";
import Markdown from "./Markdown";
import { COLORS } from "./theme";
import Composer from "./Composer";
import Attachment from "./Attachment";
import { formatBytes } from "./media";

const ANNOUNCEMENTS_SLUG = "announcements";

interface PendingAttachment {
  key: string;
  name: string;
  sizeBytes: number;
}

async function uploadFile(file: File): Promise<PendingAttachment> {
  const { url, key } = await upload.presign(file.name, file.type || "application/octet-stream", file.size);
  await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
  return { key, name: file.name, sizeBytes: file.size };
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

interface AiEntry {
  query: string;
  answer: string;
  refDocs: string[];
  aiUlid?: string;
  feedback?: "up" | "down" | null;
  streaming?: boolean;
  error?: boolean;
}

function NavItem({ icon, iconColor, label, count, active, onClick }: any) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 10px", borderRadius: 8,
        cursor: "pointer", background: active ? "rgba(255,255,255,.09)" : "transparent", fontSize: 14,
      }}
    >
      <span style={{ width: 15, textAlign: "center", color: iconColor, fontSize: 12 }}>{icon}</span>
      <span style={{ flex: 1, fontWeight: 500 }}>{label}</span>
      {count !== undefined && (
        <span style={{ fontSize: 11.5, color: COLORS.dim, fontFamily: "ui-monospace,Menlo,monospace" }}>{count}</span>
      )}
    </div>
  );
}

function MessageRow({ m, children }: { m: Message; children?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 11, padding: "10px 20px", position: "relative" }} className="msg-row-dark">
      <div style={{ width: 32, height: 32, flex: "none", borderRadius: 8, background: avatarColor(m.participantId), display: "flex", alignItems: "center", justifyContent: "center", font: "700 11px/1 inherit" }}>
        {m.participantId.slice(-2)}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>참가자 ...{m.participantId.slice(-4)}</span>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,.3)", fontFamily: "ui-monospace,Menlo,monospace" }}>{timeLabel(m.createdAt)}</span>
          {m.kind === "question" && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 5, height: 18, padding: "0 7px", borderRadius: 6,
              background: m.status === "resolved" ? "rgba(1,168,141,.16)" : "rgba(255,153,0,.16)",
              color: m.status === "resolved" ? COLORS.tealText : "#FFB84D", font: "700 10.5px/1 inherit",
            }}>
              {m.status === "resolved" ? "✓ 해결" : "미해결"} · 👍{m.upvotes}
            </span>
          )}
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.6, color: "rgba(255,255,255,.92)" }}><Markdown text={m.body} /></div>
        {m.media?.map((key) => <Attachment key={key} mediaKey={key} />)}
        {children}
      </div>
    </div>
  );
}

function ThreadPanel({ slug, message, onClose }: { slug: string; message: Message; onClose: () => void }) {
  const rootUlid = message.sk.replace("MSG#", "");
  const [replies, setReplies] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

  async function load() {
    setReplies((await api.threadReplies(rootUlid)).replies);
  }
  useEffect(() => { load(); }, [rootUlid]);

  async function send() {
    if (!draft.trim() && attachments.length === 0) return;
    await api.postMessage(slug, draft, "msg", rootUlid, attachments.map((a) => a.key));
    setDraft("");
    setAttachments([]);
    load();
  }

  return (
    <div style={{ width: 392, minWidth: 320, flex: "0 1 392px", background: COLORS.bgDark, borderLeft: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 14px 0 18px", height: 52, borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 700 }}>스레드</div>
        <button onClick={onClose} style={{ width: 28, height: 28, border: 0, borderRadius: 8, background: "rgba(255,255,255,.07)", color: "rgba(255,255,255,.6)", cursor: "pointer" }}>×</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
        <div style={{ fontSize: 14.5, lineHeight: 1.6, color: "#fff", marginBottom: 12 }}><Markdown text={message.body} /></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, borderTop: `1px solid ${COLORS.border}`, paddingTop: 14 }}>
          {replies.map((r) => (
            <div key={r.sk} style={{ display: "flex", gap: 10 }}>
              <div style={{ width: 28, height: 28, flex: "none", borderRadius: 7, background: avatarColor(r.participantId), display: "flex", alignItems: "center", justifyContent: "center", font: "700 10px/1 inherit" }}>
                {r.participantId.slice(-2)}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>참가자 ...{r.participantId.slice(-4)}</span>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,.3)", fontFamily: "ui-monospace,Menlo,monospace" }}>{timeLabel(r.createdAt)}</span>
                </div>
                <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "rgba(255,255,255,.85)" }}><Markdown text={r.body} /></div>
                {r.media?.map((key) => <Attachment key={key} mediaKey={key} />)}
              </div>
            </div>
          ))}
          {replies.length === 0 && <div style={{ fontSize: 13, color: COLORS.dim }}>아직 답변이 없습니다.</div>}
        </div>
      </div>
      <div style={{ flex: "none", padding: "12px 18px 16px" }}>
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={send}
          placeholder="답글 작성"
          onAttachFiles={(files) => Promise.all(Array.from(files).map(uploadFile)).then((added) => setAttachments((a) => [...a, ...added]))}
          extra={attachments.length > 0 && <AttachmentChips attachments={attachments} onRemove={(key) => setAttachments((a) => a.filter((x) => x.key !== key))} />}
        />
      </div>
    </div>
  );
}

function AttachmentChips({ attachments, onRemove }: { attachments: PendingAttachment[]; onRemove: (key: string) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
      {attachments.map((a) => (
        <div key={a.key} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 999, background: "rgba(255,255,255,.08)", fontSize: 12 }}>
          <span>📎 {a.name}</span>
          <span style={{ color: COLORS.dim }}>{formatBytes(a.sizeBytes)}</span>
          <button onClick={() => onRemove(a.key)} style={{ border: "none", background: "transparent", color: "rgba(255,255,255,.5)", cursor: "pointer", padding: 0, fontSize: 13 }}>×</button>
        </div>
      ))}
    </div>
  );
}

function AiView({ history, aiQuery, setAiQuery, aiBusy, ask, onFeedback }: {
  history: AiEntry[]; aiQuery: string; setAiQuery: (v: string) => void; aiBusy: boolean;
  ask: () => void; onFeedback: (i: number, fb: "up" | "down") => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: "none", padding: "16px 20px 12px", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>AI 도우미</div>
        <div style={{ fontSize: 12.5, color: COLORS.dim }}>답변은 본인에게만 표시됩니다 · 랩 가이드에 대해 질문하세요</div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
        {history.map((h, i) => (
          <div key={i}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "rgba(255,255,255,.85)", marginBottom: 8 }}>{h.query}</div>
            <div style={{
              border: `1px solid ${h.error ? "rgba(221,52,76,.45)" : "rgba(1,168,141,.3)"}`, borderRadius: 12,
              background: "rgba(255,255,255,.03)", padding: "13px 15px",
            }}>
              <div style={{ fontSize: 14, lineHeight: 1.6, color: "#fff" }}>
                <Markdown text={h.answer} renderMermaid={!h.streaming} />
                {h.streaming && <span style={{ opacity: 0.5 }}>▌</span>}
              </div>
              {!h.streaming && h.refDocs.length > 0 && (
                <div style={{ marginTop: 9, fontSize: 11.5, color: "rgba(255,255,255,.4)", fontFamily: "ui-monospace,Menlo,monospace" }}>
                  참고: {h.refDocs.join(", ")}
                </div>
              )}
              {!h.streaming && h.aiUlid && (
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button
                    onClick={() => onFeedback(i, "up")}
                    style={{ border: "1px solid rgba(255,255,255,.14)", background: h.feedback === "up" ? "rgba(1,168,141,.18)" : "transparent", color: h.feedback === "up" ? COLORS.tealText : "rgba(255,255,255,.6)", borderRadius: 999, height: 26, padding: "0 10px", cursor: "pointer", fontSize: 12 }}
                  >
                    👍 도움됨
                  </button>
                  <button
                    onClick={() => onFeedback(i, "down")}
                    style={{ border: "1px solid rgba(255,255,255,.14)", background: h.feedback === "down" ? "rgba(221,52,76,.18)" : "transparent", color: h.feedback === "down" ? COLORS.redText : "rgba(255,255,255,.6)", borderRadius: 999, height: 26, padding: "0 10px", cursor: "pointer", fontSize: 12 }}
                  >
                    👎 가이드에 없음
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        {history.length === 0 && <div style={{ color: COLORS.dim, fontSize: 13 }}>아직 질문한 내용이 없습니다.</div>}
      </div>
      <div style={{ flex: "none", padding: "12px 20px 16px" }}>
        <Composer value={aiQuery} onChange={setAiQuery} onSend={ask} placeholder="랩 가이드에 대해 질문하기" />
        {aiBusy && <div style={{ fontSize: 12, color: COLORS.dim, marginTop: 6 }}>답변 생성 중…</div>}
      </div>
    </div>
  );
}

export default function Chat({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [view, setView] = useState<"channel" | "ai">("channel");
  const [active, setActive] = useState<string>("");
  const [labStep, setLabStep] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [asQuestion, setAsQuestion] = useState(false);
  const [selectedUlid, setSelectedUlid] = useState<string | null>(null);
  const [aiQuery, setAiQuery] = useState("");
  const [aiHistory, setAiHistory] = useState<AiEntry[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  useEffect(() => {
    api.labStep().then((r) => setLabStep(r.step));
    api.channels().then((r) => {
      const visible = r.channels.filter((c) => c.scaleVisible && !c.archived);
      setChannels(visible);
      if (visible.length && !active) setActive(visible[0].pk.replace("CHANNEL#", ""));
    });
  }, []);

  // Single Fargate task (§ws-hub) means a deploy or idle timeout drops every open socket at
  // once — reconnect has to be automatic, and on reconnect the client backfills only what it
  // missed (via the last message's ulid) rather than losing history or re-fetching everything.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let retryDelayMs = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let isFirstConnect = true;

    function lastSeenUlid(): string | undefined {
      const msgs = messagesRef.current;
      return msgs.length ? msgs[msgs.length - 1].sk.replace("MSG#", "") : undefined;
    }

    function connect() {
      if (cancelled) return;
      const sinceUlid = isFirstConnect ? undefined : lastSeenUlid();
      const backfill = isFirstConnect
        ? api.messages(active).then((r) => setMessages(r.messages))
        : api.messages(active, sinceUlid).then((r) => {
            if (!r.messages.length) return;
            setMessages((prev) => {
              const seen = new Set(prev.map((m) => m.sk));
              return [...prev, ...r.messages.filter((m) => !seen.has(m.sk))];
            });
          });

      backfill.then(() => {
        if (cancelled) return;
        const ws = new WebSocket(wsUrl(active));
        ws.onopen = () => {
          retryDelayMs = 1000; // reset backoff on a clean connection
        };
        ws.onmessage = (evt) => {
          const data = JSON.parse(evt.data);
          if (data.type === "message" && !data.message.threadId) {
            setMessages((prev) => (prev.some((m) => m.sk === data.message.sk) ? prev : [...prev, data.message]));
          } else if (data.type === "upvote") {
            setMessages((prev) => prev.map((m) => (m.sk === `MSG#${data.ulid}` ? { ...m, upvotes: data.upvotes } : m)));
          } else if (data.type === "resolved") {
            setMessages((prev) => prev.map((m) => (m.sk === `MSG#${data.ulid}` ? { ...m, status: "resolved" } : m)));
          } else if (data.type === "deleted") {
            setMessages((prev) => prev.map((m) => (m.sk === `MSG#${data.ulid}` ? { ...m, deleted: true } : m)));
          }
        };
        ws.onclose = () => {
          if (cancelled) return;
          isFirstConnect = false;
          const jitter = Math.random() * 300;
          retryTimer = setTimeout(connect, retryDelayMs + jitter);
          retryDelayMs = Math.min(retryDelayMs * 2, 15_000);
        };
        wsRef.current = ws;
      });
    }

    connect();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, [active]);

  async function send() {
    if (!draft.trim() && attachments.length === 0) return;
    const isQuestions = active === "questions";
    await api.postMessage(active, draft, isQuestions && asQuestion ? "question" : "msg", undefined, attachments.map((a) => a.key));
    setDraft("");
    setAttachments([]);
    setMessages((await api.messages(active)).messages);
  }

  async function attachFiles(files: FileList) {
    const uploaded = await Promise.all(Array.from(files).map(uploadFile));
    setAttachments((a) => [...a, ...uploaded]);
  }

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    const added = await uploadFile(file);
    setAttachments((a) => [...a, added]);
  }

  async function postAsAnnouncement(m: Message) {
    await api.postMessage(ANNOUNCEMENTS_SLUG, m.body, "msg", undefined, m.media);
    setView("channel");
    setActive(ANNOUNCEMENTS_SLUG);
  }

  async function ask() {
    const query = aiQuery.trim();
    if (!query || aiBusy) return;
    setAiQuery("");
    setAiBusy(true);
    const index = aiHistory.length;
    setAiHistory((h) => [...h, { query, answer: "", refDocs: [], streaming: true }]);

    try {
      const res = await fetch("/api/ai/ask/stream", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Minimal SSE parser: split on blank-line-terminated events, each with an "event:"/"data:" pair.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const eventType = /event: (\w+)/.exec(rawEvent)?.[1];
          const dataLine = /data: (.*)/.exec(rawEvent)?.[1];
          if (!dataLine) continue;
          const payload = JSON.parse(dataLine);
          if (eventType === "delta") {
            setAiHistory((h) => h.map((e, i) => (i === index ? { ...e, answer: e.answer + payload.chunk } : e)));
          } else if (eventType === "done") {
            setAiHistory((h) => h.map((e, i) => (i === index ? { ...e, refDocs: payload.refDocs, aiUlid: payload.aiUlid, streaming: false } : e)));
          } else if (eventType === "error") {
            throw new Error(payload.error);
          }
        }
      }
    } catch (err: any) {
      setAiHistory((h) => h.map((e, i) => (i === index ? { ...e, answer: `오류: ${err.message}`, streaming: false, error: true } : e)));
    } finally {
      setAiBusy(false);
    }
  }

  async function onFeedback(i: number, fb: "up" | "down") {
    const entry = aiHistory[i];
    if (!entry.aiUlid) return;
    await api.aiFeedback(entry.aiUlid, fb);
    setAiHistory((h) => h.map((e, idx) => (idx === i ? { ...e, feedback: fb } : e)));
  }

  const sorted = active === "questions" ? [...messages].sort((a, b) => (b.upvotes ?? 0) - (a.upvotes ?? 0)) : messages;
  const selected = useMemo(() => messages.find((m) => m.sk.replace("MSG#", "") === selectedUlid) ?? null, [messages, selectedUlid]);
  const activeChannelName = channels.find((c) => c.pk.replace("CHANNEL#", "") === active)?.name ?? active;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: COLORS.bg, color: "#fff", fontSize: 14, overflow: "hidden" }}>
      <div style={{ height: 56, flex: "none", display: "flex", alignItems: "center", gap: 16, padding: "0 16px", background: COLORS.bgDark, borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
          <div style={{ width: 26, height: 26, borderRadius: 6, background: COLORS.orange, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, color: COLORS.bgDark }}>W</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Workshop Chat</div>
        </div>
        {labStep && (
          <span style={{ fontSize: 11.5, color: COLORS.dim, fontFamily: "ui-monospace,Menlo,monospace" }}>현재 랩 스텝: {labStep}</span>
        )}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 13, color: COLORS.dim }}>
            {session.role === "operator" ? "운영자" : `참가자 ...${session.participantId.slice(-4)}`}
          </span>
          <button onClick={onLogout} style={{ height: 30, padding: "0 12px", border: "1px solid rgba(255,255,255,.2)", borderRadius: 999, background: "transparent", color: "#fff", cursor: "pointer" }}>로그아웃</button>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0, overflowX: "auto" }}>
        <div style={{ width: 224, flex: "none", background: COLORS.bgDark, borderRight: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", overflowY: "auto" }}>
          <div style={{ padding: "14px 12px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: "rgba(255,255,255,.35)" }}>채널</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 8px 16px" }}>
            {channels.map((c) => {
              const slug = c.pk.replace("CHANNEL#", "");
              return (
                <NavItem key={slug} icon="#" iconColor="rgba(255,255,255,.35)" label={c.name} active={view === "channel" && active === slug}
                  onClick={() => { setView("channel"); setActive(slug); setSelectedUlid(null); }} />
              );
            })}
          </div>
          <div style={{ padding: "0 12px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: "rgba(255,255,255,.35)" }}>도우미</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 8px" }}>
            <NavItem icon="✳" iconColor={COLORS.teal} label="AI 도우미" active={view === "ai"} onClick={() => setView("ai")} />
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 480, display: "flex", flexDirection: "column", background: COLORS.bg }}>
          {view === "channel" && (
            <>
              <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 20px", height: 52, borderBottom: `1px solid ${COLORS.border}` }}>
                <span style={{ fontFamily: "ui-monospace,Menlo,monospace", color: "rgba(255,255,255,.4)", fontSize: 16 }}>#</span>
                <span style={{ fontSize: 16, fontWeight: 700 }}>{activeChannelName}</span>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "8px 0 8px" }}>
                {sorted.filter((m) => !m.deleted).map((m) => {
                  const ulid = m.sk.replace("MSG#", "");
                  return (
                    <div key={m.sk} onClick={() => setSelectedUlid(ulid)} style={{ cursor: "pointer", background: selectedUlid === ulid ? "rgba(255,153,0,.055)" : "transparent" }}>
                      <MessageRow m={m}>
                        <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
                          <button onClick={(e) => { e.stopPropagation(); setSelectedUlid(ulid); }} style={{ border: "none", background: "transparent", color: COLORS.orange, fontSize: 12.5, cursor: "pointer", padding: 0 }}>스레드</button>
                          {m.kind === "question" && (
                            <button onClick={(e) => { e.stopPropagation(); api.upvote(active, ulid); }} style={{ border: "none", background: "transparent", color: "rgba(255,255,255,.6)", fontSize: 12.5, cursor: "pointer", padding: 0 }}>👍 업보트</button>
                          )}
                          {m.kind === "question" && session.role === "operator" && m.status !== "resolved" && (
                            <button onClick={(e) => { e.stopPropagation(); api.resolve(active, ulid); }} style={{ border: "none", background: "transparent", color: "#FFB84D", fontSize: 12.5, cursor: "pointer", padding: 0 }}>해결로 표시</button>
                          )}
                          {session.role === "operator" && active !== ANNOUNCEMENTS_SLUG && (
                            <button onClick={(e) => { e.stopPropagation(); postAsAnnouncement(m); }} style={{ border: "none", background: "transparent", color: "rgba(255,255,255,.6)", fontSize: 12.5, cursor: "pointer", padding: 0 }}>📌 공지로 올리기</button>
                          )}
                          {session.role === "operator" && (
                            <button onClick={(e) => { e.stopPropagation(); api.deleteMessage(active, ulid); }} style={{ border: "none", background: "transparent", color: "rgba(255,255,255,.4)", fontSize: 12.5, cursor: "pointer", padding: 0 }}>삭제</button>
                          )}
                        </div>
                      </MessageRow>
                    </div>
                  );
                })}
              </div>
              <div style={{ flex: "none", padding: "12px 20px 16px" }}>
                {active === "questions" && (
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: COLORS.dim, marginBottom: 8 }}>
                    <input type="checkbox" checked={asQuestion} onChange={(e) => setAsQuestion(e.target.checked)} style={{ width: "auto" }} />
                    질문으로 등록
                  </label>
                )}
                <Composer
                  value={draft}
                  onChange={setDraft}
                  onSend={send}
                  onPaste={onPaste}
                  onAttachFiles={attachFiles}
                  placeholder="메시지 입력 (붙여넣기 또는 📎로 파일 첨부)"
                  extra={attachments.length > 0 && <AttachmentChips attachments={attachments} onRemove={(key) => setAttachments((a) => a.filter((x) => x.key !== key))} />}
                />
              </div>
            </>
          )}
          {view === "ai" && (
            <AiView history={aiHistory} aiQuery={aiQuery} setAiQuery={setAiQuery} aiBusy={aiBusy} ask={ask} onFeedback={onFeedback} />
          )}
        </div>

        {selected && view === "channel" && (
          <ThreadPanel slug={active} message={selected} onClose={() => setSelectedUlid(null)} />
        )}
      </div>
    </div>
  );
}
