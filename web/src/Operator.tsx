import { useEffect, useMemo, useRef, useState } from "react";
import { api, wsUrl, type AiQuery, type Attendance, type Channel, type GuideDoc, type Message, type NoShow, type Participant } from "./api";
import { avatarColor, avatarInitials, displayName } from "./format";
import Markdown from "./Markdown";
import { COLORS } from "./theme";
import Composer from "./Composer";
import Resizer from "./Resizer";
import Attachment from "./Attachment";
import { type PendingAttachment, uploadFile, AttachmentChips } from "./media";
import { useResizableWidth } from "./useResizableWidth";
import { readParams, setParams, buildMessageLink, useHighlight } from "./urlState";
import { useLocale, LocaleToggle } from "./i18n";

// Rough per-guide-doc-set char budget the AI prompt-injection fallback caps at (see
// app/src/ai/ask.ts and CLAUDE.md's "~60k chars" note) — used only to render a usage meter here,
// not enforced client-side.
const GUIDE_CONTEXT_CAP_BYTES = 60_000;

type Theme = "midnight" | "projector";

type View = "questions" | "channel" | "ai" | "docs" | "attendance" | "roster";

function timeLabel(iso: string, locale: "ko" | "en" = "ko") {
  return new Date(iso).toLocaleTimeString(locale === "en" ? "en-US" : "ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function NavItem({ icon, iconColor, label, count, active, onClick, badge, readOnly }: any) {
  const { t } = useLocale();
  return (
    <div
      onClick={onClick}
      className={active ? undefined : "hover-fill"}
      style={{
        display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 10px", borderRadius: 8,
        cursor: "pointer", background: active ? COLORS.lineStrong : "transparent", fontSize: 14,
      }}
    >
      <span style={{ width: 15, textAlign: "center", color: iconColor, fontSize: 12 }}>{icon}</span>
      <span style={{ flex: 1, fontWeight: readOnly ? 400 : 500, color: readOnly ? COLORS.fg3 : COLORS.text }}>{label}</span>
      {count !== undefined && (
        <span style={{ fontSize: 11.5, color: COLORS.dim, fontFamily: "ui-monospace,Menlo,monospace" }}>{count}</span>
      )}
      {badge && (
        <span style={{ height: 16, padding: "0 6px", borderRadius: 4, background: COLORS.fill, color: COLORS.dim, font: "500 10px/16px inherit", whiteSpace: "nowrap" }}>
          {badge}
        </span>
      )}
      {readOnly && (
        <span style={{ fontSize: 10, color: COLORS.fg4, border: `1px solid ${COLORS.lineStrong}`, borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap", flex: "none" }}>
          {t("읽기 전용")}
        </span>
      )}
    </div>
  );
}

function Chip({ label, count, active, onClick }: any) {
  return (
    <button
      onClick={onClick}
      className={active ? undefined : "hover-accent-border"}
      style={{
        height: 30, padding: "0 13px", border: `1px solid ${active ? "rgba(var(--c-accent-rgb),.55)" : COLORS.lineStrong}`,
        borderRadius: 999, background: active ? "rgba(var(--c-accent-rgb),.16)" : "transparent",
        color: active ? COLORS.orangeText : COLORS.fg2, font: "500 12.5px/1 inherit", cursor: "pointer",
        display: "flex", alignItems: "center", gap: 7, whiteSpace: "nowrap",
      }}
    >
      <span>{label}</span>
      <span style={{ fontFamily: "ui-monospace,Menlo,monospace", opacity: 0.7 }}>{count}</span>
    </button>
  );
}

// ---------- Questions board ----------

function QuestionsView({
  questions, filter, setFilter, selectedId, setSelectedId, onUpvote, onResolve, onDelete, highlighted, onCopyLink,
}: {
  questions: Message[]; filter: "open" | "all" | "top"; setFilter: (f: any) => void;
  selectedId: string | null; setSelectedId: (id: string | null) => void;
  onUpvote: (m: Message) => void; onResolve: (m: Message) => void; onDelete: (m: Message) => void;
  highlighted: string | null; onCopyLink: (ulid: string) => void;
}) {
  const { locale, t } = useLocale();
  const [search, setSearch] = useState("");
  const [showAccountIds, setShowAccountIds] = useState(false);

  const open = questions.filter((q) => q.status === "open");
  let list = filter === "open" ? open : questions.slice();
  if (filter === "top") list = [...list].sort((a, b) => b.upvotes - a.upvotes);
  else list = [...list].sort((a, b) => (a.status === b.status ? b.upvotes - a.upvotes : a.status === "open" ? -1 : 1));
  const needle = search.trim().toLowerCase();
  if (needle) list = list.filter((m) => m.body.toLowerCase().includes(needle) || displayName(m.participantId, locale).toLowerCase().includes(needle));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: "none", padding: "16px 20px 12px", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{t("질문 보드")}</div>
          <div style={{ fontSize: 12.5, color: COLORS.dim }}>{t("업보트 순 · 미해결이 위로 고정됩니다")}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Chip label={t("미해결")} count={open.length} active={filter === "open"} onClick={() => setFilter("open")} />
          <Chip label={t("전체")} count={questions.length} active={filter === "all"} onClick={() => setFilter("all")} />
          <Chip label={t("업보트 상위")} count={questions.length} active={filter === "top"} onClick={() => setFilter("top")} />
          <div style={{ flex: 1 }} />
          <button
            onClick={() => setShowAccountIds((v) => !v)}
            title={t("참가자 ID 뒷자리 노출")}
            style={{
              height: 30, padding: "0 12px", borderRadius: 8, border: `1px solid ${showAccountIds ? COLORS.orange : COLORS.lineStrong}`,
              background: showAccountIds ? "rgba(var(--c-accent-rgb),.14)" : "transparent",
              color: showAccountIds ? COLORS.orangeText : COLORS.fg4, font: "500 12.5px/1 inherit", cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            {t("ID 표시")}
          </button>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("질문 검색")}
            className="focus-ring"
            style={{
              height: 30, padding: "0 12px", borderRadius: 8, background: COLORS.fill, border: `1px solid ${COLORS.border}`,
              color: COLORS.text, font: "400 12.5px/1 inherit", outline: "none", width: 160,
            }}
          />
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0 24px" }}>
        {list.filter((q) => !q.deleted).map((q) => {
          const ulid = q.sk.replace("MSG#", "");
          const isOpen = q.status === "open";
          return (
            <div
              key={q.sk}
              data-msg-anchor={ulid}
              className={highlighted === ulid ? "msg-flash" : undefined}
              style={{ borderBottom: "1px solid rgba(var(--c-w),.055)", background: selectedId === ulid ? "rgba(var(--c-accent-rgb),.055)" : "transparent" }}
            >
              <div
                onClick={() => setSelectedId(selectedId === ulid ? null : ulid)}
                className="hover-row"
                style={{ display: "flex", gap: 14, padding: "14px 20px", cursor: "pointer" }}
              >
                <div style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 46 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); onUpvote(q); }}
                    className="hover-accent-border"
                    style={{
                      width: 46, height: 44, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                      gap: 1, border: `1px solid ${COLORS.lineStrong}`, borderRadius: 10, background: COLORS.fill,
                      color: COLORS.fg2, cursor: "pointer", fontFamily: "inherit",
                    }}
                  >
                    <span style={{ fontSize: 10, lineHeight: 1 }}>▲</span>
                    <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1, fontFamily: "ui-monospace,Menlo,monospace" }}>{q.upvotes}</span>
                  </button>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                    {isOpen ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 20, padding: "0 8px", borderRadius: 6, background: "rgba(var(--c-accent-rgb),.16)", color: COLORS.orangeText, font: "700 11px/1 inherit" }}>
                        <span style={{ width: 5, height: 5, borderRadius: "50%", background: COLORS.orange }} />{t("미해결")}
                      </span>
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 20, padding: "0 8px", borderRadius: 6, background: "rgba(var(--c-ok-rgb),.16)", color: COLORS.tealText, font: "500 11px/1 inherit" }}>
                        ✓ {t("해결")}
                      </span>
                    )}
                    <span title={`${t("참가자 ID")} ${q.participantId}`} style={{ fontSize: 12.5, fontWeight: 500, color: COLORS.fg2, borderBottom: "1px dotted rgba(var(--c-w),.3)", cursor: "help" }}>{displayName(q.participantId, locale)}</span>
                    {showAccountIds && <span style={{ fontSize: 11.5, color: COLORS.fg4, fontFamily: "ui-monospace,Menlo,monospace" }}>{q.participantId}</span>}
                    <span style={{ fontSize: 11.5, color: COLORS.fg4 }}>#{q.channel}</span>
                    <span style={{ fontSize: 11, padding: "1px 7px", borderRadius: 6, background: COLORS.fill, color: COLORS.fg3, fontFamily: "ui-monospace,Menlo,monospace" }}>{t("step")} {q.labStep}</span>
                    <span style={{ fontSize: 11.5, color: COLORS.fg4, fontFamily: "ui-monospace,Menlo,monospace" }}>{timeLabel(q.createdAt, locale)}</span>
                  </div>
                  <div style={{ fontSize: 14.5, lineHeight: 1.55, color: COLORS.text }}><Markdown text={q.body} /></div>
                  {q.media.map((key) => <Attachment key={key} mediaKey={key} />)}
                  <div style={{ marginTop: 8, fontSize: 12.5, color: q.replyCount ? COLORS.orange : COLORS.fg3, fontWeight: 500 }}>
                    {q.replyCount ? `💬 ${q.replyCount} ${locale === "en" ? (q.replyCount === 1 ? "reply" : "replies") : "개의 댓글"}` : t("답변 없음 — 지금 답해야 함")}
                  </div>
                </div>
                <div style={{ flex: "none", display: "flex", alignItems: "flex-start", gap: 6 }}>
                  {isOpen && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onResolve(q); }}
                      className="hover-accent-border"
                      style={{ height: 28, padding: "0 12px", border: "1px solid rgba(var(--c-accent-rgb),.5)", borderRadius: 999, background: "rgba(var(--c-accent-rgb),.14)", color: COLORS.orangeText, font: "500 12px/1 inherit", cursor: "pointer", whiteSpace: "nowrap" }}
                    >
                      {t("해결로 표시")}
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); onCopyLink(ulid); }}
                    title={t("링크 복사")}
                    className="hover-accent-border"
                    style={{ width: 28, height: 28, border: `1px solid ${COLORS.lineStrong}`, borderRadius: 999, background: "transparent", color: COLORS.fg3, font: "400 13px/1 inherit", cursor: "pointer" }}
                  >
                    🔗
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(q); }}
                    title={t("메시지 삭제")}
                    className="hover-danger"
                    style={{ width: 28, height: 28, border: `1px solid ${COLORS.lineStrong}`, borderRadius: 999, background: "transparent", color: COLORS.fg3, font: "400 13px/1 inherit", cursor: "pointer" }}
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {list.length === 0 && <div style={{ padding: 24, color: COLORS.dim, fontSize: 13 }}>{t("표시할 질문이 없습니다.")}</div>}
      </div>
    </div>
  );
}

// ---------- Thread panel ----------

function ThreadPanel({ channel, ulid, message, onClose, width, onResize, initialMsgUlid, onCopyLink }: {
  channel: string; ulid: string; message: Message; onClose: () => void; width: number; onResize: (deltaX: number) => void;
  initialMsgUlid?: string | null; onCopyLink: (ulid: string) => void;
}) {
  const { locale, t } = useLocale();
  const [replies, setReplies] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

  async function load() {
    setReplies((await api.threadReplies(ulid)).replies);
  }
  useEffect(() => { load(); }, [ulid]);
  // Otherwise a file picked while replying to one thread is still queued if the operator
  // switches to another thread before sending — and would get attached to the wrong reply.
  useEffect(() => { setAttachments([]); }, [ulid]);

  const highlighted = useHighlight([message, ...replies], initialMsgUlid);

  async function send() {
    if (!draft.trim() && attachments.length === 0) return;
    await api.postMessage(channel, draft, "msg", ulid, attachments.map((a) => a.key));
    setDraft("");
    setAttachments([]);
    load();
  }

  return (
    <>
      <Resizer onResize={(dx) => onResize(-dx)} />
      <div style={{ width, flex: "none", background: COLORS.bgDark, borderLeft: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 14px 0 18px", height: 52, borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700 }}>{t("스레드")}</div>
          <div style={{ fontSize: 11.5, color: COLORS.dim }}>#{message.channel} · {t("step")} {message.labStep}</div>
        </div>
        <button onClick={onClose} className="hover-fill" style={{ width: 28, height: 28, border: 0, borderRadius: 8, background: COLORS.fill, color: COLORS.fg2, cursor: "pointer" }}>×</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
        <div data-msg-anchor={ulid} className={highlighted === ulid ? "msg-flash" : undefined} style={{ borderRadius: 8, padding: 4, margin: -4, marginBottom: 8 }}>
          <Markdown text={message.body} />
          {message.media.map((key) => <Attachment key={key} mediaKey={key} />)}
          <button onClick={() => onCopyLink(ulid)} style={{ marginTop: 6, border: "none", background: "transparent", color: COLORS.fg4, fontSize: 11.5, cursor: "pointer", padding: 0 }}>🔗 {t("링크 복사")}</button>
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
                    <span style={{ fontSize: 11, color: COLORS.fg4, fontFamily: "ui-monospace,Menlo,monospace" }}>{timeLabel(r.createdAt, locale)}</span>
                  </div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.6, color: COLORS.fg2 }}>
                    <Markdown text={r.body} />
                    {r.media.map((key) => <Attachment key={key} mediaKey={key} />)}
                  </div>
                  <button onClick={() => onCopyLink(rUlid)} style={{ marginTop: 4, border: "none", background: "transparent", color: COLORS.fg4, fontSize: 11, cursor: "pointer", padding: 0 }}>🔗 {t("링크 복사")}</button>
                </div>
              </div>
            );
          })}
          {replies.length === 0 && <div style={{ fontSize: 13, color: COLORS.dim }}>{t("아직 답변이 없습니다.")}</div>}
        </div>
      </div>
      <div style={{ flex: "none", padding: "12px 18px 16px" }}>
        <Composer
          value={draft} onChange={setDraft} onSend={send} placeholder={t("운영자로 답변…")}
          onAttachFiles={(files) => Promise.all(Array.from(files).map(uploadFile)).then((added) => setAttachments((a) => [...a, ...added]))}
          extra={attachments.length > 0 && <AttachmentChips attachments={attachments} onRemove={(key) => setAttachments((a) => a.filter((x) => x.key !== key))} />}
        />
      </div>
      </div>
    </>
  );
}

// ---------- Channel view ----------

function ChannelView({ slug, name, archived, onOpenThread, initialThreadUlid, initialMsgUlid, onCopyLink }: {
  slug: string; name: string; archived: boolean; onOpenThread: (m: Message) => void;
  initialThreadUlid?: string | null; initialMsgUlid?: string | null; onCopyLink: (ulid: string) => void;
}) {
  const { locale, t } = useLocale();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const restoredThreadRef = useRef(false);
  const highlighted = useHighlight(messages, initialMsgUlid);

  useEffect(() => {
    api.messages(slug).then((r) => {
      setMessages(r.messages);
      // One-shot: opens the thread a deep link pointed at, once its root shows up in this
      // channel's own message list (ChannelView owns that list; the parent only gets told about
      // it via onOpenThread once a match is found).
      if (restoredThreadRef.current || !initialThreadUlid) return;
      const root = r.messages.find((m) => m.sk === `MSG#${initialThreadUlid}`);
      if (root) {
        restoredThreadRef.current = true;
        onOpenThread(root);
      }
    });
    wsRef.current?.close();
    const ws = new WebSocket(wsUrl(slug));
    ws.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      if (data.type === "message" && !data.message.threadId) setMessages((prev) => [...prev, data.message]);
      else if (data.type === "deleted") setMessages((prev) => prev.map((m) => (m.sk === `MSG#${data.ulid}` ? { ...m, deleted: true } : m)));
      else if (data.type === "threadReplyCount") setMessages((prev) => prev.map((m) => (m.sk === `MSG#${data.rootUlid}` ? { ...m, replyCount: data.replyCount } : m)));
    };
    wsRef.current = ws;
    return () => ws.close();
  }, [slug]);
  // Otherwise a file picked in one channel is still queued if the operator switches channels
  // before sending — and would get attached to the wrong channel's message.
  useEffect(() => { setAttachments([]); }, [slug]);

  async function send() {
    if (!draft.trim() && attachments.length === 0) return;
    await api.postMessage(slug, draft, "msg", undefined, attachments.map((a) => a.key));
    setDraft("");
    setAttachments([]);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 20px", height: 52, borderBottom: `1px solid ${COLORS.border}` }}>
        <span style={{ fontFamily: "ui-monospace,Menlo,monospace", color: COLORS.fg3, fontSize: 16 }}>#</span>
        <span style={{ fontSize: 16, fontWeight: 700 }}>{name}</span>
        {archived && (
          <span style={{ fontSize: 12.5, color: COLORS.fg3, borderLeft: `1px solid ${COLORS.lineStrong}`, paddingLeft: 10 }}>{t("아카이브 · 읽기 전용")}</span>
        )}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
        {messages.filter((m) => !m.deleted).map((m) => {
          const ulid = m.sk.replace("MSG#", "");
          return (
            <div key={m.sk} data-msg-anchor={ulid} className={`hover-row${highlighted === ulid ? " msg-flash" : ""}`} style={{ display: "flex", gap: 11, padding: "7px 10px", margin: "0 -10px", borderRadius: 8 }}>
              <div style={{ width: 32, height: 32, flex: "none", borderRadius: 8, background: avatarColor(m.participantId), display: "flex", alignItems: "center", justifyContent: "center", font: "700 11px/1 inherit" }}>
                {avatarInitials(m.participantId, locale)}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>{displayName(m.participantId, locale)}</span>
                  <span style={{ fontSize: 11, color: COLORS.fg4, fontFamily: "ui-monospace,Menlo,monospace" }}>{timeLabel(m.createdAt, locale)}</span>
                  {m.kind === "question" && m.status === "open" && (
                    <span style={{ height: 18, padding: "0 7px", borderRadius: 6, background: "rgba(var(--c-accent-rgb),.16)", color: COLORS.orangeText, font: "700 10.5px/18px inherit" }}>{t("미해결")}</span>
                  )}
                </div>
                <div style={{ fontSize: 14, lineHeight: 1.6, color: COLORS.text }}>
                  <Markdown text={m.body} />
                  {m.media.map((key) => <Attachment key={key} mediaKey={key} />)}
                </div>
                <div style={{ display: "flex", gap: 12, marginTop: 4, flexWrap: "wrap" }}>
                  <button
                    onClick={() => onOpenThread(m)}
                    style={{ border: "none", background: "transparent", color: COLORS.orange, fontSize: 12.5, cursor: "pointer", padding: 0, font: "inherit" }}
                  >
                    {m.replyCount ? `💬 ${m.replyCount} ${locale === "en" ? (m.replyCount === 1 ? "reply" : "replies") : "개의 댓글"}` : t("스레드")}
                  </button>
                  <button onClick={() => onCopyLink(ulid)} style={{ border: "none", background: "transparent", color: COLORS.fg4, fontSize: 12.5, cursor: "pointer", padding: 0, font: "inherit" }}>
                    🔗 {t("링크 복사")}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ flex: "none", padding: "12px 20px 16px" }}>
        {archived ? (
          <div style={{ fontSize: 12.5, color: COLORS.fg3, textAlign: "center", padding: "10px 0" }}>{t("이 채널은 아카이브되어 읽기 전용입니다.")}</div>
        ) : (
          <Composer
            value={draft} onChange={setDraft} onSend={send} placeholder={locale === "en" ? `Message #${name}` : `#${name} 에 메시지 보내기`}
            onAttachFiles={(files) => Promise.all(Array.from(files).map(uploadFile)).then((added) => setAttachments((a) => [...a, ...added]))}
            extra={attachments.length > 0 && <AttachmentChips attachments={attachments} onRemove={(key) => setAttachments((a) => a.filter((x) => x.key !== key))} />}
          />
        )}
      </div>
    </div>
  );
}

// ---------- AI query log ----------

function AiLogView({ queries }: { queries: AiQuery[] }) {
  const { locale, t } = useLocale();
  const good = queries.filter((q) => q.feedback === "up").length;
  const bad = queries.filter((q) => q.feedback === "down").length;
  const tokens = queries.reduce((a, q) => a + q.tokensIn + q.tokensOut, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: "none", padding: "16px 20px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{t("AI 도우미 로그")}</div>
        <div style={{ fontSize: 12.5, color: COLORS.dim, maxWidth: 620 }}>
          {t("참가자가 랩 가이드에서 찾지 못한 것의 목록입니다. 엑셀")} <span style={{ fontFamily: "ui-monospace,Menlo,monospace", color: "rgba(var(--c-w),.7)" }}>AI_Queries</span> {t("시트로 그대로 내보내집니다.")}
        </div>
        <div style={{ display: "flex", gap: 24, marginTop: 14 }}>
          <div><div style={{ fontSize: 22, fontWeight: 700 }}>{queries.length}</div><div style={{ fontSize: 11.5, color: COLORS.dim }}>{t("쿼리")}</div></div>
          <div><div style={{ fontSize: 22, fontWeight: 700, color: COLORS.tealText }}>{good}</div><div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: COLORS.dim, whiteSpace: "nowrap" }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.tealText, flex: "none" }} />{t("도움됨")}</div></div>
          <div><div style={{ fontSize: 22, fontWeight: 700, color: COLORS.redText }}>{bad}</div><div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: COLORS.dim, whiteSpace: "nowrap" }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.red, flex: "none" }} />{t("가이드에 없음 → 사람이 답할 것")}</div></div>
          <div><div style={{ fontSize: 22, fontWeight: 700 }}>{tokens.toLocaleString()}</div><div style={{ fontSize: 11.5, color: COLORS.dim }}>{t("토큰 사용")}</div></div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
        {queries.map((a) => (
          <div key={a.sk} style={{ border: `1px solid ${a.feedback === "down" ? "rgba(var(--c-danger-rgb),.45)" : "rgba(var(--c-w),.09)"}`, borderRadius: 12, background: "rgba(var(--c-w),.03)", padding: "13px 15px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 500, color: "rgba(var(--c-w),.8)" }}>{displayName(a.participantId, locale)}</span>
              <span style={{ fontSize: 11, padding: "1px 7px", borderRadius: 6, background: "rgba(var(--c-w),.07)", color: "rgba(var(--c-w),.55)", fontFamily: "ui-monospace,Menlo,monospace" }}>{t("step")} {a.labStep}</span>
              <span style={{ fontSize: 11.5, color: "rgba(var(--c-w),.3)", fontFamily: "ui-monospace,Menlo,monospace" }}>{timeLabel(a.createdAt, locale)}</span>
              <div style={{ flex: 1 }} />
              {a.feedback && (
                <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: a.feedback === "up" ? COLORS.tealText : COLORS.redText, fontWeight: 500, whiteSpace: "nowrap", flex: "none" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: a.feedback === "up" ? COLORS.tealText : COLORS.redText, flex: "none" }} />
                  {a.feedback === "up" ? t("도움됨") : t("가이드에 없음")}
                </span>
              )}
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.55, color: COLORS.text, marginBottom: 9 }}>{a.query}</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: "rgba(var(--c-w),.6)", paddingLeft: 11, borderLeft: "2px solid rgba(var(--c-ok-rgb),.5)" }}>{a.answerSummary}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 11.5, color: "rgba(var(--c-w),.4)", fontFamily: "ui-monospace,Menlo,monospace" }}>
              <span>{a.refDocs.join(", ") || `— ${t("매칭 문서 없음")}`}</span>
              <span>·</span>
              <span>in {a.tokensIn.toLocaleString()} / out {a.tokensOut.toLocaleString()}</span>
            </div>
          </div>
        ))}
        {queries.length === 0 && <div style={{ color: COLORS.dim, fontSize: 13 }}>{t("아직 AI 쿼리가 없습니다.")}</div>}
      </div>
    </div>
  );
}

// ---------- Guide documents ----------

const GUIDE_ACCEPT = ".txt,.md,.html,.doc,.docx,.csv,.xls,.xlsx,.pdf,.jpeg,.jpg,.png";

const INDEX_STATUS_META: Record<string, { label: string; color: keyof typeof COLORS; pulse?: boolean }> = {
  pending: { label: "대기중", color: "fg3" },
  indexing: { label: "인덱싱 중", color: "orangeText", pulse: true },
  retrying: { label: "재시도 중", color: "orangeText", pulse: true },
  indexed: { label: "인덱싱됨", color: "tealText" },
  failed: { label: "인덱싱 실패", color: "redText" },
};

function IndexStatusBadge({ status }: { status?: GuideDoc["indexStatus"] }) {
  const { t } = useLocale();
  if (!status) return null;
  const meta = INDEX_STATUS_META[status];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: COLORS[meta.color], whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS[meta.color], flex: "none", animation: meta.pulse ? "pulseDot 1.6s ease-in-out infinite" : undefined }} />
      {t(meta.label)}
    </div>
  );
}

function DocsView({ docs, reindexStatus, onUpload, onToggle, onDelete, onReindex }: {
  docs: GuideDoc[];
  reindexStatus: { status: string | null; startedAt?: string; attempt?: number; maxAttempts?: number; failedDocs?: string[]; nextRetryAt?: string | null };
  onUpload: (files: FileList) => void; onToggle: (key: string) => void; onDelete: (key: string) => void; onReindex: () => void;
}) {
  const { locale, t } = useLocale();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const activeCount = docs.filter((d) => d.active).length;
  const ctxBytes = docs.filter((d) => d.active).reduce((a, d) => a + d.sizeBytes, 0);
  const failedCount = reindexStatus.failedDocs?.length ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: "none", padding: "16px 20px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{t("랩 가이드 문서 · AI 컨텍스트")}</div>
          <span style={{ height: 20, padding: "0 8px", borderRadius: 6, background: "rgba(var(--c-danger-rgb),.16)", color: COLORS.redText, font: "700 11px/20px inherit", whiteSpace: "nowrap" }}>
            {t("운영자 전용")} · {t("참가자에게 보이지 않음")}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: COLORS.dim, maxWidth: 660 }}>{t("여기 올린 문서만 AI 도우미의 답변 근거로 주입됩니다.")}</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 20, marginTop: 12 }}>
          <div style={{ flex: 1, maxWidth: 420 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: COLORS.dim, marginBottom: 6 }}>
              <span>{t("프롬프트 주입 사용량")}</span>
              <span style={{ fontFamily: "ui-monospace,Menlo,monospace" }}>{(ctxBytes / 1024).toFixed(0)} KB / {(GUIDE_CONTEXT_CAP_BYTES / 1024).toFixed(0)} KB</span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: COLORS.track, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.min(100, Math.round((ctxBytes / GUIDE_CONTEXT_CAP_BYTES) * 100))}%`, background: COLORS.orange }} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1 }}>{activeCount}</div>
            <div style={{ fontSize: 11.5, color: COLORS.dim }}>{t("사용 중 문서")}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12.5, color: COLORS.dim }}>
            {t("마지막 재인덱싱")}: <span style={{ color: COLORS.text }}>{reindexStatus.status ?? t("없음")}</span>
            {reindexStatus.startedAt && <span> · {timeLabel(reindexStatus.startedAt, locale)}</span>}
            {reindexStatus.attempt !== undefined && reindexStatus.maxAttempts !== undefined && (
              <span> · {reindexStatus.attempt}/{reindexStatus.maxAttempts} {t("재시도")}</span>
            )}
          </div>
          {failedCount > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: COLORS.redText }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.red }} />
              {failedCount} {t("실패 문서")}
              {reindexStatus.status === "RETRY_SCHEDULED" && reindexStatus.nextRetryAt && (
                <span style={{ color: COLORS.fg3 }}>· {t("다음 재시도")} {timeLabel(reindexStatus.nextRetryAt, locale)}</span>
              )}
              {reindexStatus.status === "EXHAUSTED" && <span style={{ color: COLORS.fg3 }}>· {t("재시도 소진")}</span>}
            </div>
          )}
          <button
            onClick={onReindex}
            className="hover-accent-border"
            style={{ height: 30, padding: "0 14px", border: "1px solid rgba(var(--c-accent-rgb),.5)", borderRadius: 999, background: "rgba(var(--c-accent-rgb),.14)", color: COLORS.orangeText, font: "500 12.5px/1 inherit", cursor: "pointer" }}
          >
            {t("지금 재인덱싱")}
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 24px" }}>
        <input ref={fileRef} type="file" multiple accept={GUIDE_ACCEPT} style={{ display: "none" }}
          onChange={(e) => { if (e.target.files?.length) onUpload(e.target.files); e.target.value = ""; }} />
        <div
          onClick={() => fileRef.current?.click()}
          className="hover-accent-border"
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7, padding: "26px 20px", border: "1px dashed rgba(var(--c-w),.22)", borderRadius: 16, background: "rgba(var(--c-w),.03)", cursor: "pointer" }}
        >
          <div style={{ fontSize: 14, fontWeight: 500 }}>{t("랩 가이드 문서를 여기에 끌어다 놓기")}</div>
          <div style={{ fontSize: 12.5, color: COLORS.dim }}>md · pdf · txt · html · doc(x) · csv · xls(x) — {t("최대 50MB, 이미지는 3.75MB")}</div>
          <button style={{ marginTop: 5, height: 32, padding: "0 16px", border: 0, borderRadius: 999, background: COLORS.orange, color: COLORS.onAccent, font: "700 12.5px/1 inherit", cursor: "pointer" }}>
            {t("파일 선택")}
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(200px,1fr) 84px 112px 90px 70px", gap: "0 12px", padding: "16px 4px 10px", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "rgba(var(--c-w),.35)", borderBottom: `1px solid ${COLORS.border}` }}>
          <div>{t("문서")}</div><div>{t("크기")}</div><div>{t("인덱싱")}</div><div>{t("상태")}</div><div></div>
        </div>
        {docs.map((d) => (
          <div key={d.key} style={{ display: "grid", gridTemplateColumns: "minmax(200px,1fr) 84px 112px 90px 70px", gap: "0 12px", alignItems: "center", padding: "12px 4px", borderBottom: "1px solid rgba(var(--c-w),.055)" }}>
            <div style={{ minWidth: 0, fontFamily: "ui-monospace,Menlo,monospace", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</div>
            <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5, color: "rgba(var(--c-w),.6)" }}>{(d.sizeBytes / 1024).toFixed(0)} KB</div>
            <div><IndexStatusBadge status={d.indexStatus} /></div>
            <div>
              <button onClick={() => onToggle(d.key)} style={{ display: "flex", alignItems: "center", gap: 8, border: 0, background: "transparent", cursor: "pointer", padding: 0, font: "500 12px/1 inherit", color: d.active ? COLORS.orangeText : "rgba(var(--c-w),.4)" }}>
                <span style={{ width: 30, height: 17, borderRadius: 999, background: d.active ? COLORS.orange : "rgba(var(--c-w),.18)", position: "relative", flex: "none" }}>
                  <span style={{ position: "absolute", top: 2, left: d.active ? 15 : 2, width: 13, height: 13, borderRadius: "50%", background: "#fff" }} />
                </span>
                {d.active ? t("사용 중") : t("제외")}
              </button>
            </div>
            <div>
              <button onClick={() => onDelete(d.key)} className="hover-danger" style={{ height: 26, padding: "0 11px", border: "1px solid rgba(var(--c-w),.16)", borderRadius: 999, background: "transparent", color: "rgba(var(--c-w),.6)", font: "500 11.5px/1 inherit", cursor: "pointer" }}>
                {t("삭제")}
              </button>
            </div>
          </div>
        ))}
        {docs.length === 0 && <div style={{ padding: "16px 4px", color: COLORS.dim, fontSize: 13 }}>{t("업로드된 문서가 없습니다.")}</div>}
      </div>
    </div>
  );
}

// ---------- Attendance ----------

function AttendanceView({ attendance, error, onResend }: { attendance: Attendance | null; error: string | null; onResend: (n: NoShow) => void }) {
  const { t } = useLocale();
  // Distinguish "the fetch failed" from "attendance hasn't loaded yet" — a silent `return null`
  // for both used to make a broken Cognito lookup indistinguishable from a quiet screen, letting
  // the UI fall back to fabricated numbers elsewhere instead of surfacing the real problem.
  if (error) {
    return (
      <div style={{ padding: 20, color: COLORS.redText, fontSize: 13.5 }}>
        {t("참가자 명단을 불러올 수 없습니다 (Cognito 권한 확인 필요)")}: {error}
      </div>
    );
  }
  if (!attendance) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: "none", padding: "16px 20px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{t("참여 현황 · 아직 입장 안 한 참가자")}</div>
        <div style={{ fontSize: 12.5, color: COLORS.dim }}>{t("입장하지 않은 참가자는 조인 링크를 재전송하세요.")}</div>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <div style={{ flex: 1, padding: "12px 14px", borderRadius: 12, background: "rgba(var(--c-w),.04)", border: `1px solid ${COLORS.border}` }}>
            <div style={{ fontSize: 11, color: COLORS.dim, marginBottom: 5 }}>{t("예상 참가자")}</div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{attendance.expectedCount}</div>
          </div>
          <div style={{ flex: 1, padding: "12px 14px", borderRadius: 12, background: "rgba(var(--c-w),.04)", border: `1px solid ${COLORS.border}` }}>
            <div style={{ fontSize: 11, color: COLORS.dim, marginBottom: 5 }}>{t("입장 완료")}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.tealText }}>{attendance.joinedCount}</div>
          </div>
          <div style={{ flex: 1, padding: "12px 14px", borderRadius: 12, background: "rgba(var(--c-danger-rgb),.14)", border: "1px solid rgba(var(--c-danger-rgb),.45)" }}>
            <div style={{ fontSize: 11, color: COLORS.redText, marginBottom: 5 }}>{t("미입장")}</div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{attendance.noShowCount}</div>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 24px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "150px 1fr 96px", gap: "0 14px", padding: "11px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "rgba(var(--c-w),.35)", borderBottom: `1px solid ${COLORS.border}`, marginTop: 8 }}>
          <div>{t("참가자 ID")}</div><div></div><div></div>
        </div>
        {attendance.noShows.map((n) => (
          <div key={n.participantId} className="hover-row" style={{ display: "grid", gridTemplateColumns: "150px 1fr 96px", gap: "0 14px", alignItems: "center", padding: "11px 4px", borderBottom: "1px solid rgba(var(--c-w),.055)", fontSize: 13.5 }}>
            <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5, color: COLORS.fg2 }}>{n.participantId}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: COLORS.redText }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.redText }} />{t("미입장")}
            </div>
            <div><button onClick={() => onResend(n)} className="hover-accent-border" style={{ height: 26, padding: "0 11px", border: "1px solid rgba(var(--c-w),.18)", borderRadius: 999, background: "transparent", color: COLORS.fg2, font: "500 11.5px/1 inherit", cursor: "pointer" }}>{t("링크 복사")}</button></div>
          </div>
        ))}
        {attendance.noShows.length === 0 && <div style={{ padding: "16px 4px", color: COLORS.dim, fontSize: 13 }}>{t("모든 참가자가 입장했습니다.")}</div>}
      </div>
    </div>
  );
}

function RosterView({ roster, source, error, participants, onCopyLink, onBlock, onUnblock }: {
  roster: { participantId: string; joinUrl: string }[];
  source: "cognito" | "derived" | null;
  error: string | null;
  participants: Participant[];
  onCopyLink: (url: string) => void;
  onBlock: (id: string) => void;
  onUnblock: (id: string) => void;
}) {
  const { t } = useLocale();
  if (error) {
    return (
      <div style={{ padding: 20, color: COLORS.redText, fontSize: 13.5 }}>
        {t("참가자 명단을 불러올 수 없습니다 (Cognito 권한 확인 필요)")}: {error}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflowY: "auto" }}>
      <div style={{ flex: "none", padding: "16px 20px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{t("로스터 · 조인 링크")}</div>
              {source === "derived" && (
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: "rgba(var(--c-danger-rgb),.14)", border: "1px solid rgba(var(--c-danger-rgb),.45)", color: COLORS.redText }}>
                  {t("로컬 파생 로스터")}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12.5, color: COLORS.dim }}>{t("참가자에게 배포할 조인 링크입니다. QR을 인쇄하거나 CSV로 내려받을 수 있습니다.")}</div>
          </div>
          <a href="/api/operator/roster.csv" className="hover-accent-border" style={{ height: 30, padding: "0 14px", display: "flex", alignItems: "center", border: "1px solid rgba(var(--c-w),.18)", borderRadius: 999, color: COLORS.fg2, fontSize: 12.5, fontWeight: 600, textDecoration: "none", flexShrink: 0 }}>
            {t("CSV 다운로드")}
          </a>
        </div>
      </div>
      <div style={{ padding: "0 20px 8px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "150px 1fr 80px 90px", gap: "0 14px", padding: "11px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "rgba(var(--c-w),.35)", borderBottom: `1px solid ${COLORS.border}`, marginTop: 8 }}>
          <div>{t("참가자 ID")}</div><div>{t("조인 링크")}</div><div></div><div></div>
        </div>
        {roster.map((r) => (
          <div key={r.participantId} className="hover-row" style={{ display: "grid", gridTemplateColumns: "150px 1fr 80px 90px", gap: "0 14px", alignItems: "center", padding: "11px 4px", borderBottom: "1px solid rgba(var(--c-w),.055)", fontSize: 13.5 }}>
            <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5, color: COLORS.fg2 }}>{r.participantId}</div>
            <div style={{ fontSize: 12, color: COLORS.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.joinUrl}</div>
            <a href={`/api/operator/roster/${encodeURIComponent(r.participantId)}/qr.png`} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: COLORS.fg2, textDecoration: "none" }}>{t("QR 보기")}</a>
            <button onClick={() => onCopyLink(r.joinUrl)} className="hover-accent-border" style={{ height: 26, padding: "0 11px", border: "1px solid rgba(var(--c-w),.18)", borderRadius: 999, background: "transparent", color: COLORS.fg2, font: "500 11.5px/1 inherit", cursor: "pointer" }}>{t("복사")}</button>
          </div>
        ))}
        {roster.length === 0 && <div style={{ padding: "16px 4px", color: COLORS.dim, fontSize: 13 }}>{t("생성된 로스터가 없습니다 (participantCount=0).")}</div>}
      </div>

      <div style={{ flex: "none", padding: "20px 20px 14px", borderTop: `1px solid ${COLORS.border}`, borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{t("참가자 관리 · 차단")}</div>
        <div style={{ fontSize: 12.5, color: COLORS.dim }}>{t("입장한 참가자만 표시됩니다. 차단된 참가자는 메시지를 보낼 수 없습니다.")}</div>
      </div>
      <div style={{ padding: "0 20px 24px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "150px 90px 90px 1fr 90px", gap: "0 14px", padding: "11px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "rgba(var(--c-w),.35)", borderBottom: `1px solid ${COLORS.border}`, marginTop: 8 }}>
          <div>{t("참가자 ID")}</div><div>{t("질문")}</div><div>{t("AI 질문")}</div><div>{t("상태")}</div><div></div>
        </div>
        {participants.map((p) => (
          <div key={p.participantId} className="hover-row" style={{ display: "grid", gridTemplateColumns: "150px 90px 90px 1fr 90px", gap: "0 14px", alignItems: "center", padding: "11px 4px", borderBottom: "1px solid rgba(var(--c-w),.055)", fontSize: 13.5 }}>
            <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5, color: COLORS.fg2 }}>{p.participantId}</div>
            <div style={{ fontSize: 12.5, color: COLORS.dim }}>{p.questionCount}</div>
            <div style={{ fontSize: 12.5, color: COLORS.dim }}>{p.aiQueryCount}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: p.blocked ? COLORS.redText : COLORS.tealText }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: p.blocked ? COLORS.redText : COLORS.tealText }} />
              {p.blocked ? t("차단됨") : t("활동중")}
            </div>
            <div>
              {p.blocked ? (
                <button onClick={() => onUnblock(p.participantId)} className="hover-accent-border" style={{ height: 26, padding: "0 11px", border: "1px solid rgba(var(--c-w),.18)", borderRadius: 999, background: "transparent", color: COLORS.fg2, font: "500 11.5px/1 inherit", cursor: "pointer" }}>{t("차단 해제")}</button>
              ) : (
                <button onClick={() => onBlock(p.participantId)} className="hover-danger" style={{ height: 26, padding: "0 11px", border: "1px solid rgba(var(--c-w),.18)", borderRadius: 999, background: "transparent", color: COLORS.fg2, font: "500 11.5px/1 inherit", cursor: "pointer" }}>{t("차단")}</button>
              )}
            </div>
          </div>
        ))}
        {participants.length === 0 && <div style={{ padding: "16px 4px", color: COLORS.dim, fontSize: 13 }}>{t("아직 입장한 참가자가 없습니다.")}</div>}
      </div>
    </div>
  );
}

// ---------- Main ----------

export default function Operator({ onLogout }: { onLogout: () => void }) {
  const { locale, t } = useLocale();
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("wc:opTheme") as Theme | null) ?? "midnight",
  );
  useEffect(() => {
    document.body.dataset.theme = theme;
    localStorage.setItem("wc:opTheme", theme);
    // Projector mode is an operator-console-only affordance — clear it on unmount so it doesn't
    // leak into the participant Chat view after logout (both mount under the same <body>).
    return () => { delete document.body.dataset.theme; };
  }, [theme]);
  const toggleTheme = () => setTheme((th) => (th === "projector" ? "midnight" : "projector"));

  const initialParams = useMemo(readParams, []);
  const initialView = initialParams.get("view") as View | null;
  const VALID_VIEWS: View[] = ["questions", "channel", "ai", "docs", "attendance", "roster"];
  const initialThreadUlid = initialParams.get("thread");
  const initialMsgUlid = initialParams.get("msg");

  const [labStep, setLabStepState] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [view, setView] = useState<View>(initialView && VALID_VIEWS.includes(initialView) ? initialView : "questions");
  const [activeChannel, setActiveChannel] = useState<string>(initialParams.get("channel") ?? "");
  const [channelThread, setChannelThread] = useState<Message | null>(null);
  const [questions, setQuestions] = useState<Message[]>([]);
  const [filter, setFilter] = useState<"open" | "all" | "top">("open");
  const [selectedId, setSelectedId] = useState<string | null>(initialThreadUlid);
  const [aiQueries, setAiQueries] = useState<AiQuery[]>([]);
  const [docs, setDocs] = useState<GuideDoc[]>([]);
  const [reindex, setReindex] = useState<{
    status: string | null; startedAt?: string; attempt?: number; maxAttempts?: number; failedDocs?: string[]; nextRetryAt?: string | null;
  }>({ status: null });
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);
  const [roster, setRoster] = useState<{ participantId: string; joinUrl: string }[]>([]);
  const [rosterSource, setRosterSource] = useState<"cognito" | "derived" | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [exportRowCounts, setExportRowCounts] = useState<Record<string, number> | null>(null);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<any>(null);
  const [sidebarWidth, resizeSidebar] = useResizableWidth("wc:opSidebarWidth", 264, 200, 460);
  const [threadWidth, resizeThread] = useResizableWidth("wc:opThreadWidth", 392, 280, 1200);

  function showToast(msg: string) {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }

  // Keeps the address bar refresh-safe and shareable (e.g. a link straight into the questions
  // board, a channel, or an open thread within either) without a router dependency — see
  // urlState.ts.
  useEffect(() => {
    setParams({
      view,
      channel: view === "channel" ? activeChannel || undefined : undefined,
      thread: view === "questions" ? selectedId ?? undefined : view === "channel" ? channelThread?.sk.replace("MSG#", "") : undefined,
    });
  }, [view, activeChannel, selectedId, channelThread]);

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      showToast(t("링크를 복사했습니다"));
    } catch {
      showToast(url);
    }
  }

  async function loadQuestions() {
    // Dedicated GSI-backed endpoint, not a per-channel messages() scan (which caps at 100 and
    // silently drops older open questions once a busy channel outgrows that page) — see
    // GET /api/questions in chat.ts.
    const [open, resolved] = await Promise.all([api.questions("open"), api.questions("resolved")]);
    setQuestions([...open.questions, ...resolved.questions]);
  }

  async function refresh() {
    const [step, chans, exportStatus] = await Promise.all([api.labStep(), api.channels(), api.exportStatus()]);
    setLabStepState(step.step);
    setChannels(chans.channels);
    setLastExport(exportStatus.lastExportAt);
    setExportRowCounts(exportStatus.rowCounts);
    await loadQuestions();
  }

  function loadAttendance() {
    api.attendance().then((a) => { setAttendance(a); setAttendanceError(null); }).catch((err) => setAttendanceError(err.message));
  }

  function loadRoster() {
    api.roster().then((r) => { setRoster(r.roster); setRosterSource(r.source); setRosterError(null); }).catch((err) => setRosterError(err.message));
  }

  useEffect(() => {
    refresh();
    loadAttendance();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (view === "ai") api.aiQueries().then((r) => setAiQueries(r.queries));
    if (view === "attendance") loadAttendance();
    if (view === "roster") {
      loadRoster();
      api.participants().then((r) => setParticipants(r.participants));
    }
  }, [view]);

  // Docs view polls on its own short interval (not just on entry) — indexing status changes in
  // the background (the reindex retry loop ticks every 30s independently of this tab being
  // open), so a one-shot fetch would go stale while the operator is watching it.
  useEffect(() => {
    if (view !== "docs") return;
    let cancelled = false;
    const load = () => {
      api.guideDocs().then((r) => { if (!cancelled) setDocs(r.docs); });
      api.reindexStatus().then((r) => { if (!cancelled) setReindex(r); });
    };
    load();
    const interval = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [view]);

  const selected = useMemo(() => questions.find((q) => q.sk.replace("MSG#", "") === selectedId) ?? null, [questions, selectedId]);
  const openCount = questions.filter((q) => q.status === "open").length;
  const questionsHighlighted = useHighlight(questions, view === "questions" ? initialMsgUlid : null);

  async function exportNow() {
    if (exporting) return;
    setExporting(true);
    try {
      await api.exportNow();
      const status = await api.exportStatus();
      setLastExport(status.lastExportAt);
      setExportRowCounts(status.rowCounts);
      showToast(t("xlsx 내보내기 완료"));
    } finally {
      setExporting(false);
    }
  }

  async function uploadGuideDocs(files: FileList) {
    for (const file of Array.from(files)) {
      try {
        const { url } = await api.presignGuideDoc(file.name, file.type || "application/octet-stream", file.size);
        await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
      } catch (err: any) {
        showToast(`${file.name} ${t("업로드 실패")}: ${err.message}`);
        continue;
      }
    }
    await api.markGuideDocUploaded();
    setDocs((await api.guideDocs()).docs);
    showToast(t("업로드 완료 · 재인덱싱이 필요합니다"));
  }

  const channelName = (slug: string) => channels.find((c) => c.pk.replace("CHANNEL#", "") === slug)?.name ?? slug;
  const channelArchived = (slug: string) => channels.find((c) => c.pk.replace("CHANNEL#", "") === slug)?.archived ?? false;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: COLORS.bg, color: COLORS.text, fontSize: 14, overflow: "hidden" }}>
      {/* Top bar */}
      <div style={{ height: 56, flex: "none", display: "flex", alignItems: "center", gap: 16, padding: "0 16px", background: COLORS.bgDark, borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, width: 248, flex: "none" }}>
          <div style={{ width: 26, height: 26, borderRadius: 6, background: COLORS.orange, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, color: COLORS.onAccent }}>W</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{t("Workshop Chat · 운영자")}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: COLORS.dim, textTransform: "uppercase", fontWeight: 700 }}>{t("현재 랩 스텝")}</span>
          <input
            value={labStep}
            onChange={(e) => setLabStepState(e.target.value)}
            onBlur={() => api.setLabStep(labStep)}
            onKeyDown={(e) => e.key === "Enter" && api.setLabStep(labStep)}
            style={{ height: 32, padding: "0 12px", border: "1px solid rgba(var(--c-accent-rgb),.5)", borderRadius: 8, background: "rgba(var(--c-accent-rgb),.12)", color: COLORS.text, font: "500 13px/1 inherit" }}
          />
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
            <div style={{ fontSize: 11, color: COLORS.dim }}>{t("마지막 내보내기")}</div>
            <div style={{ fontSize: 12, fontFamily: "ui-monospace,Menlo,monospace" }}>{lastExport ? timeLabel(lastExport, locale) : t("아직 없음")}</div>
            {exportRowCounts && (
              // Evidence the export isn't silently truncated (DynamoDB's 1MB page cap) — matches
              // the Meta sheet inside the xlsx itself, so what's on screen is what's in the file.
              <div style={{ fontSize: 10.5, color: "rgba(var(--c-w),.35)", fontFamily: "ui-monospace,Menlo,monospace" }}>
                Q{exportRowCounts.Questions} · AI{exportRowCounts.AI_Queries} · P{exportRowCounts.Participants} · T{exportRowCounts.Timeline}
              </div>
            )}
          </div>
          <button onClick={exportNow} disabled={exporting} style={{ height: 34, padding: "0 18px", border: 0, borderRadius: 999, background: COLORS.orange, color: COLORS.onAccent, font: "700 13px/1 inherit", cursor: "pointer" }}>
            {exporting ? t("내보내는 중…") : t("지금 내보내기")}
          </button>
          <a href="/api/export"><button style={{ height: 34, padding: "0 14px", border: "1px solid rgba(var(--c-w),.2)", borderRadius: 999, background: "transparent", color: COLORS.text, cursor: "pointer" }}>{t("다운로드")}</button></a>
          <button
            onClick={toggleTheme}
            title={t("프로젝터 가시성 테마 전환")}
            className="hover-accent-border"
            style={{ display: "flex", alignItems: "center", gap: 7, height: 32, padding: "0 13px", border: `1px solid ${COLORS.lineStrong}`, borderRadius: 999, background: "transparent", color: COLORS.fg2, font: "500 12.5px/1 inherit", cursor: "pointer", whiteSpace: "nowrap" }}
          >
            <span style={{ width: 9, height: 9, borderRadius: 2, background: COLORS.orange }} />
            {theme === "projector" ? t("프로젝터 모드") : t("다크 모드")}
          </button>
          <button
            onClick={() => api.operatorLoginLink().then(({ loginUrl }) => copyLink(loginUrl))}
            title={t("로그인 링크 복사")}
            style={{ height: 32, padding: "0 13px", border: `1px solid ${COLORS.lineStrong}`, borderRadius: 999, background: "transparent", color: COLORS.fg2, font: "500 12.5px/1 inherit", cursor: "pointer", whiteSpace: "nowrap" }}
          >
            🔗 {t("로그인 링크 복사")}
          </button>
          <LocaleToggle />
          <div style={{ width: 1, height: 24, background: "rgba(var(--c-w),.12)" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: 7, background: COLORS.red, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 11 }}>{locale === "en" ? "OP" : "운영"}</div>
            <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap" }}>{t("운영자")}</span>
          </div>
          <div style={{ width: 1, height: 24, background: "rgba(var(--c-w),.12)" }} />
          <button onClick={onLogout} style={{ height: 34, padding: "0 14px", border: "1px solid rgba(var(--c-w),.2)", borderRadius: 999, background: "transparent", color: COLORS.text, cursor: "pointer" }}>{t("로그아웃")}</button>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0, overflowX: "auto" }}>
        {/* Sidebar */}
        <div style={{ width: sidebarWidth, flex: "none", background: COLORS.bgDark, borderRight: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", overflowY: "auto" }}>
          <div
            onClick={() => setView("attendance")}
            className="hover-fill"
            style={{ margin: "14px 12px 8px", padding: 12, borderRadius: 12, background: "rgba(var(--c-danger-rgb),.14)", border: "1px solid rgba(var(--c-danger-rgb),.45)", cursor: "pointer" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 9 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.red, animation: "pulseDot 1.6s ease-in-out infinite" }} />
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: COLORS.redText }}>{t("아직 입장 안 한 참가자")}</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 30, fontWeight: 700, lineHeight: 1 }}>{attendance?.noShowCount ?? "—"}</span>
              <span style={{ fontSize: 13, color: COLORS.fg2 }}>/ {attendance?.expectedCount ?? "—"}</span>
            </div>
            {attendance && attendance.expectedCount > 0 && (
              <div style={{ marginTop: 9, height: 4, borderRadius: 2, background: COLORS.track, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.round((attendance.joinedCount / attendance.expectedCount) * 100)}%`, background: COLORS.orange }} />
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 11.5, color: COLORS.fg3, display: "flex", justifyContent: "space-between" }}>
              <span>{t("입장 완료")} {attendance?.joinedCount ?? "—"}</span>
              <span style={{ color: COLORS.orange, fontWeight: 500 }}>{t("확인")} →</span>
            </div>
          </div>

          <div style={{ padding: "10px 12px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: COLORS.fg4 }}>{t("채널")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 8px" }}>
            {channels.map((c) => {
              const slug = c.pk.replace("CHANNEL#", "");
              return (
                <NavItem
                  key={slug}
                  icon="#" iconColor={COLORS.fg4} label={c.name} readOnly={c.archived}
                  active={view === "channel" && activeChannel === slug}
                  onClick={() => { setView("channel"); setActiveChannel(slug); setChannelThread(null); }}
                />
              );
            })}
          </div>

          <div style={{ padding: "16px 12px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: "rgba(var(--c-w),.35)" }}>{t("운영")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 8px 16px" }}>
            <NavItem icon="◗" iconColor={COLORS.orange} label={t("질문 보드")} count={`${openCount} ${t("open")}`} active={view === "questions"} onClick={() => setView("questions")} />
            <NavItem icon="✳" iconColor={COLORS.teal} label={t("AI 도우미 로그")} count={aiQueries.length || undefined} active={view === "ai"} onClick={() => setView("ai")} />
            <NavItem icon="▤" iconColor="rgba(var(--c-w),.5)" label={t("랩 가이드 문서")} badge={t("운영자 전용")} active={view === "docs"} onClick={() => setView("docs")} />
            <NavItem icon="◎" iconColor="rgba(var(--c-w),.5)" label={t("참여 현황")} active={view === "attendance"} onClick={() => setView("attendance")} />
            <NavItem icon="☰" iconColor="rgba(var(--c-w),.5)" label={t("로스터 · 참가자 관리")} active={view === "roster"} onClick={() => setView("roster")} />
          </div>

          <div style={{ flex: 1 }} />
          <div style={{ margin: "0 12px 14px", padding: "11px 12px", borderRadius: 12, background: "rgba(var(--c-w),.04)" }}>
            <div style={{ fontSize: 11, color: COLORS.dim, lineHeight: 1.5 }}>
              {t("워크샵 계정은 언젠가 삭제됩니다. 종료 전 xlsx를 반드시 다운로드하세요.")}
            </div>
          </div>
        </div>
        <Resizer onResize={resizeSidebar} />

        {/* Main */}
        <div style={{ flex: 1, minWidth: 540, display: "flex", flexDirection: "column", background: COLORS.bg }}>
          {view === "questions" && (
            <QuestionsView
              questions={questions} filter={filter} setFilter={setFilter} selectedId={selectedId} setSelectedId={setSelectedId}
              onUpvote={(q) => api.upvote(q.channel, q.sk.replace("MSG#", "")).then(() => loadQuestions())}
              onResolve={(q) => api.resolve(q.channel, q.sk.replace("MSG#", "")).then(() => { loadQuestions(); showToast(t("해결로 표시했습니다")); })}
              onDelete={(q) => api.deleteMessage(q.channel, q.sk.replace("MSG#", "")).then(() => { loadQuestions(); showToast(t("메시지를 삭제했습니다")); })}
              highlighted={questionsHighlighted}
              onCopyLink={(ulid) => copyLink(buildMessageLink({ view: "questions", thread: ulid }))}
            />
          )}
          {view === "channel" && activeChannel && (
            <ChannelView
              slug={activeChannel} name={channelName(activeChannel)} archived={channelArchived(activeChannel)} onOpenThread={setChannelThread}
              initialThreadUlid={initialThreadUlid} initialMsgUlid={initialMsgUlid}
              onCopyLink={(ulid) => copyLink(buildMessageLink({ view: "channel", channel: activeChannel, msg: ulid }))}
            />
          )}
          {view === "ai" && <AiLogView queries={aiQueries} />}
          {view === "docs" && (
            <DocsView
              docs={docs} reindexStatus={reindex} onUpload={uploadGuideDocs}
              onToggle={(key) => api.toggleGuideDoc(key).then(() => api.guideDocs().then((r) => setDocs(r.docs)))}
              onDelete={(key) => api.deleteGuideDoc(key).then(() => { api.guideDocs().then((r) => setDocs(r.docs)); showToast(t("문서를 삭제했습니다")); })}
              onReindex={() => api.reindexGuideDocs().then((r) => { setReindex(r); showToast(t("재인덱싱을 시작했습니다")); }).catch((err) => showToast(err.message))}
            />
          )}
          {view === "attendance" && (
            <AttendanceView
              attendance={attendance}
              error={attendanceError}
              onResend={(n) => copyLink(n.joinUrl)}
            />
          )}
          {view === "roster" && (
            <RosterView
              roster={roster}
              source={rosterSource}
              error={rosterError}
              participants={participants}
              onCopyLink={copyLink}
              onBlock={(id) => api.block(id).then(() => api.participants().then((r) => { setParticipants(r.participants); showToast(t("참가자를 차단했습니다")); }))}
              onUnblock={(id) => api.unblock(id).then(() => api.participants().then((r) => { setParticipants(r.participants); showToast(t("차단을 해제했습니다")); }))}
            />
          )}
        </div>

        {selected && view === "questions" && (
          <ThreadPanel
            channel={selected.channel} ulid={selected.sk.replace("MSG#", "")} message={selected} onClose={() => setSelectedId(null)} width={threadWidth} onResize={resizeThread}
            initialMsgUlid={initialMsgUlid}
            onCopyLink={(msgUlid) => copyLink(buildMessageLink({ view: "questions", thread: selectedId ?? undefined, msg: msgUlid }))}
          />
        )}
        {channelThread && view === "channel" && (
          <ThreadPanel
            channel={channelThread.channel} ulid={channelThread.sk.replace("MSG#", "")} message={channelThread} onClose={() => setChannelThread(null)} width={threadWidth} onResize={resizeThread}
            initialMsgUlid={initialMsgUlid}
            onCopyLink={(msgUlid) => copyLink(buildMessageLink({ view: "channel", channel: activeChannel, thread: channelThread.sk.replace("MSG#", ""), msg: msgUlid }))}
          />
        )}
      </div>

      {toast && (
        <div style={{
          position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 80,
          display: "flex", alignItems: "center", gap: 10, padding: "11px 18px", borderRadius: 999,
          background: COLORS.bg3, border: `1px solid ${COLORS.lineStrong}`, boxShadow: COLORS.shadow,
          fontSize: 13, fontWeight: 500,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.orange, flex: "none" }} />
          {toast}
        </div>
      )}
    </div>
  );
}
