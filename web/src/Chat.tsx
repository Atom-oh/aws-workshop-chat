import { useEffect, useMemo, useRef, useState } from "react";
import { api, wsUrl, type Channel, type Message, type Session } from "./api";
import { avatarColor, avatarInitials, displayName } from "./format";
import Markdown from "./Markdown";
import { COLORS } from "./theme";
import Composer from "./Composer";
import Attachment from "./Attachment";
import Resizer from "./Resizer";
import { useResizableWidth } from "./useResizableWidth";
import { type PendingAttachment, uploadFile, AttachmentChips } from "./media";
import { readParams, setParams, buildMessageLink, useHighlight } from "./urlState";
import { useLocale, LocaleToggle } from "./i18n";

const ANNOUNCEMENTS_SLUG = "announcements";

type Theme = "midnight" | "projector";

function timeLabel(iso: string, locale: "ko" | "en" = "ko") {
  return new Date(iso).toLocaleTimeString(locale === "en" ? "en-US" : "ko-KR", { hour: "2-digit", minute: "2-digit" });
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
        cursor: "pointer", background: active ? "rgba(var(--c-w),.09)" : "transparent", fontSize: 14,
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
  const { locale, t } = useLocale();
  return (
    <div style={{ display: "flex", gap: 11, padding: "10px 20px", position: "relative" }} className="msg-row-dark">
      <div style={{ width: 32, height: 32, flex: "none", borderRadius: 8, background: avatarColor(m.participantId), display: "flex", alignItems: "center", justifyContent: "center", font: "700 11px/1 inherit" }}>
        {avatarInitials(m.participantId, locale)}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>{displayName(m.participantId, locale)}</span>
          <span style={{ fontSize: 11, color: "rgba(var(--c-w),.3)", fontFamily: "ui-monospace,Menlo,monospace" }}>{timeLabel(m.createdAt, locale)}</span>
          {m.kind === "question" && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 5, height: 18, padding: "0 7px", borderRadius: 6,
              background: m.status === "resolved" ? "rgba(var(--c-ok-rgb),.16)" : "rgba(var(--c-accent-rgb),.16)",
              color: m.status === "resolved" ? COLORS.tealText : COLORS.orangeText, font: "700 10.5px/1 inherit",
            }}>
              {m.status === "resolved" ? `✓ ${t("해결")}` : t("미해결")} · 👍{m.upvotes}
            </span>
          )}
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.6, color: "rgba(var(--c-w),.92)" }}><Markdown text={m.body} /></div>
        {m.media?.map((key) => <Attachment key={key} mediaKey={key} />)}
        {children}
      </div>
    </div>
  );
}

function ThreadPanel({ slug, message, onClose, width, onResize, initialMsgUlid, onCopyLink, onError }: {
  slug: string; message: Message; onClose: () => void; width: number; onResize: (deltaX: number) => void;
  initialMsgUlid?: string | null; onCopyLink: (ulid: string) => void; onError: (message: string) => void;
}) {
  const { locale, t } = useLocale();
  const rootUlid = message.sk.replace("MSG#", "");
  const [replies, setReplies] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

  async function load() {
    setReplies((await api.threadReplies(rootUlid)).replies);
  }
  useEffect(() => { load(); }, [rootUlid]);

  const highlighted = useHighlight([message, ...replies], initialMsgUlid);

  async function send() {
    if (!draft.trim() && attachments.length === 0) return;
    try {
      await api.postMessage(slug, draft, "msg", rootUlid, attachments.map((a) => a.key));
      setDraft("");
      setAttachments([]);
      load();
    } catch (err: any) {
      onError(err.message);
    }
  }

  return (
    <>
      <Resizer onResize={(dx) => onResize(-dx)} />
      <div style={{ width, flex: "none", background: COLORS.bgDark, borderLeft: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 14px 0 18px", height: 52, borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 700 }}>{t("스레드")}</div>
        <button onClick={onClose} style={{ width: 28, height: 28, border: 0, borderRadius: 8, background: "rgba(var(--c-w),.07)", color: "rgba(var(--c-w),.6)", cursor: "pointer" }}>×</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
        <div data-msg-anchor={rootUlid} className={highlighted === rootUlid ? "msg-flash" : undefined} style={{ borderRadius: 8, padding: 4, margin: -4, marginBottom: 8 }}>
          <div style={{ fontSize: 14.5, lineHeight: 1.6, color: COLORS.text }}><Markdown text={message.body} /></div>
          <button onClick={() => onCopyLink(rootUlid)} style={{ marginTop: 6, border: "none", background: "transparent", color: "rgba(var(--c-w),.4)", fontSize: 11.5, cursor: "pointer", padding: 0 }}>🔗 {t("링크 복사")}</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, borderTop: `1px solid ${COLORS.border}`, paddingTop: 14 }}>
          {replies.map((r) => {
            const rUlid = r.sk.replace("MSG#", "");
            return (
              <div key={r.sk} data-msg-anchor={rUlid} className={highlighted === rUlid ? "msg-flash" : undefined} style={{ display: "flex", gap: 10, borderRadius: 8, padding: 4, margin: -4 }}>
                <div style={{ width: 28, height: 28, flex: "none", borderRadius: 7, background: avatarColor(r.participantId), display: "flex", alignItems: "center", justifyContent: "center", font: "700 10px/1 inherit" }}>
                  {avatarInitials(r.participantId, locale)}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500 }}>{displayName(r.participantId, locale)}</span>
                    <span style={{ fontSize: 11, color: "rgba(var(--c-w),.3)", fontFamily: "ui-monospace,Menlo,monospace" }}>{timeLabel(r.createdAt, locale)}</span>
                  </div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "rgba(var(--c-w),.85)" }}><Markdown text={r.body} /></div>
                  {r.media?.map((key) => <Attachment key={key} mediaKey={key} />)}
                  <button onClick={() => onCopyLink(rUlid)} style={{ marginTop: 4, border: "none", background: "transparent", color: "rgba(var(--c-w),.35)", fontSize: 11, cursor: "pointer", padding: 0 }}>🔗 {t("링크 복사")}</button>
                </div>
              </div>
            );
          })}
          {replies.length === 0 && <div style={{ fontSize: 13, color: COLORS.dim }}>{t("아직 답변이 없습니다.")}</div>}
        </div>
      </div>
      <div style={{ flex: "none", padding: "12px 18px 16px" }}>
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={send}
          placeholder={t("답글 작성")}
          onAttachFiles={(files) => Promise.all(Array.from(files).map(uploadFile)).then((added) => setAttachments((a) => [...a, ...added]))}
          extra={attachments.length > 0 && <AttachmentChips attachments={attachments} onRemove={(key) => setAttachments((a) => a.filter((x) => x.key !== key))} />}
        />
      </div>
      </div>
    </>
  );
}

function AiView({ history, aiQuery, setAiQuery, aiBusy, ask, onFeedback }: {
  history: AiEntry[]; aiQuery: string; setAiQuery: (v: string) => void; aiBusy: boolean;
  ask: () => void; onFeedback: (i: number, fb: "up" | "down") => void;
}) {
  const { t } = useLocale();
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: "none", padding: "16px 20px 12px", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>{t("AI 도우미")}</div>
        <div style={{ fontSize: 12.5, color: COLORS.dim }}>{t("답변은 본인에게만 표시됩니다 · 랩 가이드에 대해 질문하세요")}</div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
        {history.map((h, i) => (
          <div key={i}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "rgba(var(--c-w),.85)", marginBottom: 8 }}>{h.query}</div>
            <div style={{
              border: `1px solid ${h.error ? "rgba(var(--c-danger-rgb),.45)" : "rgba(var(--c-ok-rgb),.3)"}`, borderRadius: 12,
              background: "rgba(var(--c-w),.03)", padding: "13px 15px",
            }}>
              <div style={{ fontSize: 14, lineHeight: 1.6, color: COLORS.text }}>
                <Markdown text={h.answer} renderMermaid={!h.streaming} />
                {h.streaming && <span style={{ opacity: 0.5 }}>▌</span>}
              </div>
              {!h.streaming && h.refDocs.length > 0 && (
                <div style={{ marginTop: 9, fontSize: 11.5, color: "rgba(var(--c-w),.4)", fontFamily: "ui-monospace,Menlo,monospace" }}>
                  {t("참고")}: {h.refDocs.join(", ")}
                </div>
              )}
              {!h.streaming && h.aiUlid && (
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button
                    onClick={() => onFeedback(i, "up")}
                    style={{ border: "1px solid rgba(var(--c-w),.14)", background: h.feedback === "up" ? "rgba(var(--c-ok-rgb),.18)" : "transparent", color: h.feedback === "up" ? COLORS.tealText : "rgba(var(--c-w),.6)", borderRadius: 999, height: 26, padding: "0 10px", cursor: "pointer", fontSize: 12 }}
                  >
                    👍 {t("도움됨")}
                  </button>
                  <button
                    onClick={() => onFeedback(i, "down")}
                    style={{ border: "1px solid rgba(var(--c-w),.14)", background: h.feedback === "down" ? "rgba(var(--c-danger-rgb),.18)" : "transparent", color: h.feedback === "down" ? COLORS.redText : "rgba(var(--c-w),.6)", borderRadius: 999, height: 26, padding: "0 10px", cursor: "pointer", fontSize: 12 }}
                  >
                    👎 {t("가이드에 없음")}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        {history.length === 0 && <div style={{ color: COLORS.dim, fontSize: 13 }}>{t("아직 질문한 내용이 없습니다.")}</div>}
      </div>
      <div style={{ flex: "none", padding: "12px 20px 16px" }}>
        <Composer value={aiQuery} onChange={setAiQuery} onSend={ask} placeholder={t("랩 가이드에 대해 질문하기")} />
        {aiBusy && <div style={{ fontSize: 12, color: COLORS.dim, marginTop: 6 }}>{t("답변 생성 중…")}</div>}
      </div>
    </div>
  );
}

export default function Chat({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const { locale, t } = useLocale();
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("wc:theme") as Theme | null) ?? "midnight",
  );
  useEffect(() => {
    document.body.dataset.theme = theme;
    localStorage.setItem("wc:theme", theme);
    return () => { delete document.body.dataset.theme; };
  }, [theme]);
  const toggleTheme = () => setTheme((th) => (th === "projector" ? "midnight" : "projector"));

  const initialParams = useMemo(readParams, []);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [view, setView] = useState<"channel" | "ai">(initialParams.get("view") === "ai" ? "ai" : "channel");
  const [active, setActive] = useState<string>(initialParams.get("channel") ?? "");
  const [labStep, setLabStep] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [asQuestion, setAsQuestion] = useState(false);
  const [selectedUlid, setSelectedUlid] = useState<string | null>(initialParams.get("thread"));
  const initialMsgUlid = initialParams.get("msg");
  const [aiQuery, setAiQuery] = useState("");
  const [aiHistory, setAiHistory] = useState<AiEntry[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [sidebarWidth, resizeSidebar] = useResizableWidth("wc:sidebarWidth", 224, 160, 420);
  const [threadWidth, resizeThread] = useResizableWidth("wc:threadWidth", 392, 280, 1200);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  function showToast(msg: string) {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      showToast(t("링크를 복사했습니다"));
    } catch {
      showToast(url);
    }
  }

  const mainHighlighted = useHighlight(messages, initialMsgUlid);

  useEffect(() => {
    api.labStep().then((r) => setLabStep(r.step));
    api.channels().then((r) => {
      const visible = r.channels.filter((c) => c.scaleVisible && !c.archived);
      setChannels(visible);
      if (visible.length && !active) setActive(visible[0].pk.replace("CHANNEL#", ""));
    });
  }, []);

  // Keeps the address bar refresh-safe and shareable (e.g. a link straight into #announcements)
  // without a router dependency — see urlState.ts.
  useEffect(() => {
    setParams({
      view: view === "ai" ? "ai" : undefined,
      channel: view === "channel" ? active || undefined : undefined,
      thread: view === "channel" ? selectedUlid ?? undefined : undefined,
    });
  }, [view, active, selectedUlid]);

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
          } else if (data.type === "threadReplyCount") {
            setMessages((prev) => prev.map((m) => (m.sk === `MSG#${data.rootUlid}` ? { ...m, replyCount: data.replyCount } : m)));
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
    try {
      await api.postMessage(active, draft, isQuestions && asQuestion ? "question" : "msg", undefined, attachments.map((a) => a.key));
      setDraft("");
      setAttachments([]);
      setMessages((await api.messages(active)).messages);
    } catch (err: any) {
      showToast(err.message);
    }
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

  async function toggleUpvote(ulid: string) {
    try {
      const { upvotes, upvoted } = await api.upvote(active, ulid);
      setMessages((prev) =>
        prev.map((m) => {
          if (m.sk !== `MSG#${ulid}`) return m;
          const upvoterIds = upvoted
            ? [...(m.upvoterIds ?? []), session.participantId]
            : (m.upvoterIds ?? []).filter((id) => id !== session.participantId);
          return { ...m, upvotes, upvoterIds };
        }),
      );
    } catch (err: any) {
      showToast(err.message);
    }
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
      setAiHistory((h) => h.map((e, i) => (i === index ? { ...e, answer: `${t("오류")}: ${err.message}`, streaming: false, error: true } : e)));
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
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: COLORS.bg, color: COLORS.text, fontSize: 14, overflow: "hidden" }}>
      <div style={{ height: 56, flex: "none", display: "flex", alignItems: "center", gap: 16, padding: "0 16px", background: COLORS.bgDark, borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
          <div style={{ width: 26, height: 26, borderRadius: 6, background: COLORS.orange, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, color: COLORS.bgDark }}>W</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Workshop Chat</div>
        </div>
        {labStep && (
          <span style={{ fontSize: 11.5, color: COLORS.dim, fontFamily: "ui-monospace,Menlo,monospace" }}>{t("현재 랩 스텝")}: {labStep}</span>
        )}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button
            onClick={toggleTheme}
            title={t("프로젝터 가시성 테마 전환")}
            style={{ display: "flex", alignItems: "center", gap: 7, height: 30, padding: "0 12px", border: "1px solid rgba(var(--c-w),.2)", borderRadius: 999, background: "transparent", color: COLORS.text, font: "500 12.5px/1 inherit", cursor: "pointer", whiteSpace: "nowrap" }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS.orange }} />
            {theme === "projector" ? t("프로젝터 모드") : t("다크 모드")}
          </button>
          <LocaleToggle />
          {session.role === "operator" && (
            <a href="/operator" style={{ fontSize: 13, color: COLORS.orange, textDecoration: "none", fontWeight: 600 }}>{t("운영자 화면으로 이동")} →</a>
          )}
          <span style={{ fontSize: 13, color: COLORS.dim }}>
            {displayName(session.role === "operator" ? "operator" : session.participantId, locale)}
          </span>
          <button onClick={onLogout} style={{ height: 30, padding: "0 12px", border: "1px solid rgba(var(--c-w),.2)", borderRadius: 999, background: "transparent", color: COLORS.text, cursor: "pointer" }}>{t("로그아웃")}</button>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0, overflowX: "auto" }}>
        <div style={{ width: sidebarWidth, flex: "none", background: COLORS.bgDark, borderRight: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", overflowY: "auto" }}>
          <div style={{ padding: "14px 12px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: "rgba(var(--c-w),.35)" }}>{t("채널")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 8px 16px" }}>
            {channels.map((c) => {
              const slug = c.pk.replace("CHANNEL#", "");
              return (
                <NavItem key={slug} icon="#" iconColor="rgba(var(--c-w),.35)" label={c.name} active={view === "channel" && active === slug}
                  onClick={() => { setView("channel"); setActive(slug); setSelectedUlid(null); }} />
              );
            })}
          </div>
          <div style={{ padding: "0 12px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: "rgba(var(--c-w),.35)" }}>{t("도우미")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 8px" }}>
            <NavItem icon="✳" iconColor={COLORS.teal} label={t("AI 도우미")} active={view === "ai"} onClick={() => setView("ai")} />
          </div>
        </div>
        <Resizer onResize={resizeSidebar} />

        <div style={{ flex: 1, minWidth: 480, display: "flex", flexDirection: "column", background: COLORS.bg }}>
          {view === "channel" && (
            <>
              <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 20px", height: 52, borderBottom: `1px solid ${COLORS.border}` }}>
                <span style={{ fontFamily: "ui-monospace,Menlo,monospace", color: "rgba(var(--c-w),.4)", fontSize: 16 }}>#</span>
                <span style={{ fontSize: 16, fontWeight: 700 }}>{activeChannelName}</span>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "8px 0 8px" }}>
                {sorted.filter((m) => !m.deleted).map((m) => {
                  const ulid = m.sk.replace("MSG#", "");
                  return (
                    <div
                      key={m.sk}
                      data-msg-anchor={ulid}
                      onClick={() => setSelectedUlid(ulid)}
                      className={mainHighlighted === ulid ? "msg-flash" : undefined}
                      style={{ cursor: "pointer", background: selectedUlid === ulid ? "rgba(var(--c-accent-rgb),.055)" : "transparent" }}
                    >
                      <MessageRow m={m}>
                        <div style={{ display: "flex", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
                          <button onClick={(e) => { e.stopPropagation(); setSelectedUlid(ulid); }} style={{ border: "none", background: "transparent", color: COLORS.orange, fontSize: 12.5, cursor: "pointer", padding: 0 }}>
                            {m.replyCount ? `💬 ${m.replyCount} ${locale === "en" ? (m.replyCount === 1 ? "reply" : "replies") : "개의 댓글"}` : t("스레드")}
                          </button>
                          {m.kind === "question" && (
                            <button onClick={(e) => { e.stopPropagation(); toggleUpvote(ulid); }} style={{ border: "none", background: "transparent", color: m.upvoterIds?.includes(session.participantId) ? COLORS.orange : "rgba(var(--c-w),.6)", fontSize: 12.5, cursor: "pointer", padding: 0 }}>👍 {t("업보트")}</button>
                          )}
                          {m.kind === "question" && session.role === "operator" && m.status !== "resolved" && (
                            <button onClick={(e) => { e.stopPropagation(); api.resolve(active, ulid); }} style={{ border: "none", background: "transparent", color: COLORS.orangeText, fontSize: 12.5, cursor: "pointer", padding: 0 }}>{t("해결로 표시")}</button>
                          )}
                          {session.role === "operator" && active !== ANNOUNCEMENTS_SLUG && (
                            <button onClick={(e) => { e.stopPropagation(); postAsAnnouncement(m); }} style={{ border: "none", background: "transparent", color: "rgba(var(--c-w),.6)", fontSize: 12.5, cursor: "pointer", padding: 0 }}>{t("📌 공지로 올리기")}</button>
                          )}
                          {session.role === "operator" && (
                            <button onClick={(e) => { e.stopPropagation(); api.deleteMessage(active, ulid); }} style={{ border: "none", background: "transparent", color: "rgba(var(--c-w),.4)", fontSize: 12.5, cursor: "pointer", padding: 0 }}>{t("삭제")}</button>
                          )}
                          <button onClick={(e) => { e.stopPropagation(); copyLink(buildMessageLink({ channel: active, msg: ulid })); }} style={{ border: "none", background: "transparent", color: "rgba(var(--c-w),.4)", fontSize: 12.5, cursor: "pointer", padding: 0 }}>🔗 {t("링크 복사")}</button>
                        </div>
                      </MessageRow>
                    </div>
                  );
                })}
              </div>
              <div style={{ flex: "none", padding: "12px 20px 16px" }}>
                {active === ANNOUNCEMENTS_SLUG && session.role !== "operator" ? (
                  <div style={{ padding: "10px 12px", borderRadius: 10, background: COLORS.fill, color: COLORS.fg3, fontSize: 12.5, textAlign: "center" }}>
                    {t("이 채널은 운영자만 글을 올릴 수 있습니다.")}
                  </div>
                ) : (
                  <>
                    {active === "questions" && (
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: COLORS.dim, marginBottom: 8 }}>
                        <input type="checkbox" checked={asQuestion} onChange={(e) => setAsQuestion(e.target.checked)} style={{ width: "auto" }} />
                        {t("질문으로 등록")}
                      </label>
                    )}
                    <Composer
                      value={draft}
                      onChange={setDraft}
                      onSend={send}
                      onPaste={onPaste}
                      onAttachFiles={attachFiles}
                      placeholder={t("메시지 입력 (붙여넣기 또는 📎로 파일 첨부)")}
                      extra={attachments.length > 0 && <AttachmentChips attachments={attachments} onRemove={(key) => setAttachments((a) => a.filter((x) => x.key !== key))} />}
                    />
                  </>
                )}
              </div>
            </>
          )}
          {view === "ai" && (
            <AiView history={aiHistory} aiQuery={aiQuery} setAiQuery={setAiQuery} aiBusy={aiBusy} ask={ask} onFeedback={onFeedback} />
          )}
        </div>

        {selected && view === "channel" && (
          <ThreadPanel
            slug={active} message={selected} onClose={() => setSelectedUlid(null)} width={threadWidth} onResize={resizeThread}
            initialMsgUlid={initialMsgUlid}
            onCopyLink={(ulid) => copyLink(buildMessageLink({ channel: active, thread: selectedUlid ?? undefined, msg: ulid }))}
            onError={showToast}
          />
        )}
      </div>

      {toast && (
        <div style={{
          position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 80,
          display: "flex", alignItems: "center", gap: 10, padding: "11px 18px", borderRadius: 999,
          background: COLORS.bg3, border: "1px solid rgba(var(--c-w),.14)", boxShadow: "0 4px 20px rgba(0,7,22,.5)",
          fontSize: 13, fontWeight: 500,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.orange, flex: "none" }} />
          {toast}
        </div>
      )}
    </div>
  );
}
