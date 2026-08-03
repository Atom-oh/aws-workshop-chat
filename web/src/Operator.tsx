import { useEffect, useMemo, useRef, useState } from "react";
import { api, wsUrl, type AiQuery, type Attendance, type Channel, type GuideDoc, type Message, type NoShow } from "./api";
import { avatarColor, avatarInitials, displayName } from "./format";
import Markdown from "./Markdown";
import { COLORS } from "./theme";
import Composer from "./Composer";
import Resizer from "./Resizer";
import { useResizableWidth } from "./useResizableWidth";

type View = "questions" | "channel" | "ai" | "docs" | "attendance";

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function NavItem({ icon, iconColor, label, count, active, onClick, badge }: any) {
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
      {badge && (
        <span style={{ height: 16, padding: "0 6px", borderRadius: 4, background: "rgba(255,255,255,.09)", color: COLORS.dim, font: "500 10px/16px inherit", whiteSpace: "nowrap" }}>
          {badge}
        </span>
      )}
    </div>
  );
}

function Chip({ label, count, active, onClick }: any) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 30, padding: "0 13px", border: `1px solid ${active ? "rgba(255,153,0,.55)" : "rgba(255,255,255,.16)"}`,
        borderRadius: 999, background: active ? "rgba(255,153,0,.16)" : "transparent",
        color: active ? "#FFB84D" : "rgba(255,255,255,.72)", font: "500 12.5px/1 inherit", cursor: "pointer",
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
  questions, filter, setFilter, selectedId, setSelectedId, onUpvote, onResolve, onDelete,
}: {
  questions: Message[]; filter: "open" | "all" | "top"; setFilter: (f: any) => void;
  selectedId: string | null; setSelectedId: (id: string | null) => void;
  onUpvote: (m: Message) => void; onResolve: (m: Message) => void; onDelete: (m: Message) => void;
}) {
  const open = questions.filter((q) => q.status === "open");
  let list = filter === "open" ? open : questions.slice();
  if (filter === "top") list = [...list].sort((a, b) => b.upvotes - a.upvotes);
  else list = [...list].sort((a, b) => (a.status === b.status ? b.upvotes - a.upvotes : a.status === "open" ? -1 : 1));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: "none", padding: "16px 20px 12px", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>질문 보드</div>
          <div style={{ fontSize: 12.5, color: COLORS.dim }}>업보트 순 · 미해결이 위로 고정됩니다</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Chip label="미해결" count={open.length} active={filter === "open"} onClick={() => setFilter("open")} />
          <Chip label="전체" count={questions.length} active={filter === "all"} onClick={() => setFilter("all")} />
          <Chip label="업보트 상위" count={questions.length} active={filter === "top"} onClick={() => setFilter("top")} />
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0 24px" }}>
        {list.filter((q) => !q.deleted).map((q) => {
          const ulid = q.sk.replace("MSG#", "");
          const isOpen = q.status === "open";
          return (
            <div
              key={q.sk}
              style={{ borderBottom: "1px solid rgba(255,255,255,.055)", background: selectedId === ulid ? "rgba(255,153,0,.055)" : "transparent" }}
            >
              <div
                onClick={() => setSelectedId(selectedId === ulid ? null : ulid)}
                style={{ display: "flex", gap: 14, padding: "14px 20px", cursor: "pointer" }}
              >
                <div style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 46 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); onUpvote(q); }}
                    style={{
                      width: 46, height: 44, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                      gap: 1, border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, background: "rgba(255,255,255,.05)",
                      color: "rgba(255,255,255,.75)", cursor: "pointer", fontFamily: "inherit",
                    }}
                  >
                    <span style={{ fontSize: 10, lineHeight: 1 }}>▲</span>
                    <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1, fontFamily: "ui-monospace,Menlo,monospace" }}>{q.upvotes}</span>
                  </button>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                    {isOpen ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 20, padding: "0 8px", borderRadius: 6, background: "rgba(255,153,0,.16)", color: "#FFB84D", font: "700 11px/1 inherit" }}>
                        <span style={{ width: 5, height: 5, borderRadius: "50%", background: COLORS.orange }} />미해결
                      </span>
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 20, padding: "0 8px", borderRadius: 6, background: "rgba(1,168,141,.16)", color: COLORS.tealText, font: "500 11px/1 inherit" }}>
                        ✓ 해결
                      </span>
                    )}
                    <span style={{ fontSize: 12.5, fontWeight: 500, color: "rgba(255,255,255,.8)" }}>{displayName(q.participantId)}</span>
                    <span style={{ fontSize: 11.5, color: "rgba(255,255,255,.35)" }}>#{q.channel}</span>
                    <span style={{ fontSize: 11, padding: "1px 7px", borderRadius: 6, background: "rgba(255,255,255,.07)", color: "rgba(255,255,255,.55)", fontFamily: "ui-monospace,Menlo,monospace" }}>step {q.labStep}</span>
                    <span style={{ fontSize: 11.5, color: "rgba(255,255,255,.3)", fontFamily: "ui-monospace,Menlo,monospace" }}>{timeLabel(q.createdAt)}</span>
                  </div>
                  <div style={{ fontSize: 14.5, lineHeight: 1.55, color: "rgba(255,255,255,.94)" }}><Markdown text={q.body} /></div>
                  {!!q.replyCount && (
                    <div style={{ marginTop: 6, fontSize: 12, color: COLORS.orange }}>💬 {q.replyCount}개의 댓글</div>
                  )}
                </div>
                <div style={{ flex: "none", display: "flex", alignItems: "flex-start", gap: 6 }}>
                  {isOpen && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onResolve(q); }}
                      style={{ height: 28, padding: "0 12px", border: "1px solid rgba(255,153,0,.5)", borderRadius: 999, background: "rgba(255,153,0,.14)", color: "#FFB84D", font: "500 12px/1 inherit", cursor: "pointer", whiteSpace: "nowrap" }}
                    >
                      해결로 표시
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(q); }}
                    title="메시지 삭제"
                    style={{ width: 28, height: 28, border: "1px solid rgba(255,255,255,.12)", borderRadius: 999, background: "transparent", color: "rgba(255,255,255,.45)", font: "400 13px/1 inherit", cursor: "pointer" }}
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {list.length === 0 && <div style={{ padding: 24, color: COLORS.dim, fontSize: 13 }}>표시할 질문이 없습니다.</div>}
      </div>
    </div>
  );
}

// ---------- Thread panel ----------

function ThreadPanel({ channel, ulid, message, onClose, width, onResize }: {
  channel: string; ulid: string; message: Message; onClose: () => void; width: number; onResize: (deltaX: number) => void;
}) {
  const [replies, setReplies] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");

  async function load() {
    setReplies((await api.threadReplies(ulid)).replies);
  }
  useEffect(() => { load(); }, [ulid]);

  async function send() {
    if (!draft.trim()) return;
    await api.postMessage(channel, draft, "msg", ulid);
    setDraft("");
    load();
  }

  return (
    <>
      <Resizer onResize={(dx) => onResize(-dx)} />
      <div style={{ width, flex: "none", background: COLORS.bgDark, borderLeft: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 14px 0 18px", height: 52, borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700 }}>스레드</div>
          <div style={{ fontSize: 11.5, color: COLORS.dim }}>#{message.channel} · step {message.labStep}</div>
        </div>
        <button onClick={onClose} style={{ width: 28, height: 28, border: 0, borderRadius: 8, background: "rgba(255,255,255,.07)", color: "rgba(255,255,255,.6)", cursor: "pointer" }}>×</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
        <div style={{ fontSize: 14.5, lineHeight: 1.6, color: "#fff", marginBottom: 12 }}><Markdown text={message.body} /></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, borderTop: `1px solid ${COLORS.border}`, paddingTop: 14 }}>
          {replies.map((r) => (
            <div key={r.sk} style={{ display: "flex", gap: 10 }}>
              <div style={{ width: 28, height: 28, flex: "none", borderRadius: 7, background: avatarColor(r.participantId), display: "flex", alignItems: "center", justifyContent: "center", font: "700 10px/1 inherit" }}>
                {avatarInitials(r.participantId)}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>{displayName(r.participantId)}</span>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,.3)", fontFamily: "ui-monospace,Menlo,monospace" }}>{timeLabel(r.createdAt)}</span>
                </div>
                <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "rgba(255,255,255,.85)" }}><Markdown text={r.body} /></div>
              </div>
            </div>
          ))}
          {replies.length === 0 && <div style={{ fontSize: 13, color: COLORS.dim }}>아직 답변이 없습니다.</div>}
        </div>
      </div>
      <div style={{ flex: "none", padding: "12px 18px 16px" }}>
        <Composer value={draft} onChange={setDraft} onSend={send} placeholder="운영자로 답변…" />
      </div>
      </div>
    </>
  );
}

// ---------- Channel view ----------

function ChannelView({ slug, name, onOpenThread }: { slug: string; name: string; onOpenThread: (m: Message) => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    api.messages(slug).then((r) => setMessages(r.messages));
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

  async function send() {
    if (!draft.trim()) return;
    await api.postMessage(slug, draft, "msg");
    setDraft("");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 20px", height: 52, borderBottom: `1px solid ${COLORS.border}` }}>
        <span style={{ fontFamily: "ui-monospace,Menlo,monospace", color: "rgba(255,255,255,.4)", fontSize: 16 }}>#</span>
        <span style={{ fontSize: 16, fontWeight: 700 }}>{name}</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
        {messages.filter((m) => !m.deleted).map((m) => (
          <div key={m.sk} style={{ display: "flex", gap: 11, padding: "7px 10px", margin: "0 -10px", borderRadius: 8 }}>
            <div style={{ width: 32, height: 32, flex: "none", borderRadius: 8, background: avatarColor(m.participantId), display: "flex", alignItems: "center", justifyContent: "center", font: "700 11px/1 inherit" }}>
              {avatarInitials(m.participantId)}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>{displayName(m.participantId)}</span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,.3)", fontFamily: "ui-monospace,Menlo,monospace" }}>{timeLabel(m.createdAt)}</span>
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.6, color: "rgba(255,255,255,.9)" }}><Markdown text={m.body} /></div>
              <button
                onClick={() => onOpenThread(m)}
                style={{ border: "none", background: "transparent", color: COLORS.orange, fontSize: 12.5, cursor: "pointer", padding: "4px 0 0", font: "inherit" }}
              >
                {m.replyCount ? `💬 ${m.replyCount}개의 댓글` : "스레드"}
              </button>
            </div>
          </div>
        ))}
      </div>
      <div style={{ flex: "none", padding: "12px 20px 16px" }}>
        <Composer value={draft} onChange={setDraft} onSend={send} placeholder={`#${name} 에 메시지 보내기`} />
      </div>
    </div>
  );
}

// ---------- AI query log ----------

function AiLogView({ queries }: { queries: AiQuery[] }) {
  const good = queries.filter((q) => q.feedback === "up").length;
  const bad = queries.filter((q) => q.feedback === "down").length;
  const tokens = queries.reduce((a, q) => a + q.tokensIn + q.tokensOut, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: "none", padding: "16px 20px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>AI 도우미 로그</div>
        <div style={{ fontSize: 12.5, color: COLORS.dim, maxWidth: 620 }}>
          참가자가 랩 가이드에서 찾지 못한 것의 목록입니다. 엑셀 <span style={{ fontFamily: "ui-monospace,Menlo,monospace", color: "rgba(255,255,255,.7)" }}>AI_Queries</span> 시트로 그대로 내보내집니다.
        </div>
        <div style={{ display: "flex", gap: 24, marginTop: 14 }}>
          <div><div style={{ fontSize: 22, fontWeight: 700 }}>{queries.length}</div><div style={{ fontSize: 11.5, color: COLORS.dim }}>쿼리</div></div>
          <div><div style={{ fontSize: 22, fontWeight: 700, color: COLORS.tealText }}>{good}</div><div style={{ fontSize: 11.5, color: COLORS.dim }}>👍 도움됨</div></div>
          <div><div style={{ fontSize: 22, fontWeight: 700, color: COLORS.redText }}>{bad}</div><div style={{ fontSize: 11.5, color: COLORS.dim }}>👎 → 사람이 답할 것</div></div>
          <div><div style={{ fontSize: 22, fontWeight: 700 }}>{tokens.toLocaleString()}</div><div style={{ fontSize: 11.5, color: COLORS.dim }}>토큰 사용</div></div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
        {queries.map((a) => (
          <div key={a.sk} style={{ border: `1px solid ${a.feedback === "down" ? "rgba(221,52,76,.45)" : "rgba(255,255,255,.09)"}`, borderRadius: 12, background: "rgba(255,255,255,.03)", padding: "13px 15px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 500, color: "rgba(255,255,255,.8)" }}>{displayName(a.participantId)}</span>
              <span style={{ fontSize: 11, padding: "1px 7px", borderRadius: 6, background: "rgba(255,255,255,.07)", color: "rgba(255,255,255,.55)", fontFamily: "ui-monospace,Menlo,monospace" }}>step {a.labStep}</span>
              <span style={{ fontSize: 11.5, color: "rgba(255,255,255,.3)", fontFamily: "ui-monospace,Menlo,monospace" }}>{timeLabel(a.createdAt)}</span>
              <div style={{ flex: 1 }} />
              {a.feedback && (
                <span style={{ fontSize: 12, color: a.feedback === "up" ? COLORS.tealText : COLORS.redText, fontWeight: 500 }}>
                  {a.feedback === "up" ? "👍 도움됨" : "👎 가이드에 없음"}
                </span>
              )}
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.55, color: "#fff", marginBottom: 9 }}>{a.query}</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: "rgba(255,255,255,.6)", paddingLeft: 11, borderLeft: "2px solid rgba(1,168,141,.5)" }}>{a.answerSummary}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 11.5, color: "rgba(255,255,255,.4)", fontFamily: "ui-monospace,Menlo,monospace" }}>
              <span>{a.refDocs.join(", ") || "— 매칭 문서 없음"}</span>
              <span>·</span>
              <span>in {a.tokensIn.toLocaleString()} / out {a.tokensOut.toLocaleString()}</span>
            </div>
          </div>
        ))}
        {queries.length === 0 && <div style={{ color: COLORS.dim, fontSize: 13 }}>아직 AI 쿼리가 없습니다.</div>}
      </div>
    </div>
  );
}

// ---------- Guide documents ----------

const GUIDE_ACCEPT = ".txt,.md,.html,.doc,.docx,.csv,.xls,.xlsx,.pdf,.jpeg,.jpg,.png";

function DocsView({ docs, reindexStatus, onUpload, onToggle, onDelete, onReindex }: {
  docs: GuideDoc[]; reindexStatus: { status: string | null; startedAt?: string };
  onUpload: (files: FileList) => void; onToggle: (key: string) => void; onDelete: (key: string) => void; onReindex: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const activeCount = docs.filter((d) => d.active).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: "none", padding: "16px 20px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>랩 가이드 문서 · AI 컨텍스트</div>
          <span style={{ height: 20, padding: "0 8px", borderRadius: 6, background: "rgba(221,52,76,.16)", color: "#FFB0BB", font: "700 11px/20px inherit", whiteSpace: "nowrap" }}>
            운영자 전용 · 참가자에게 보이지 않음
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: COLORS.dim, maxWidth: 660 }}>여기 올린 문서만 AI 도우미의 답변 근거로 주입됩니다.</div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 12 }}>
          <div style={{ fontSize: 12.5, color: COLORS.dim }}>
            마지막 재인덱싱: <span style={{ color: "#fff" }}>{reindexStatus.status ?? "없음"}</span>
            {reindexStatus.startedAt && <span> · {timeLabel(reindexStatus.startedAt)}</span>}
          </div>
          <button
            onClick={onReindex}
            style={{ height: 30, padding: "0 14px", border: "1px solid rgba(255,153,0,.5)", borderRadius: 999, background: "rgba(255,153,0,.14)", color: "#FFB84D", font: "500 12.5px/1 inherit", cursor: "pointer" }}
          >
            지금 재인덱싱
          </button>
          <div style={{ marginLeft: "auto" }}>
            <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1 }}>{activeCount}</div>
            <div style={{ fontSize: 11.5, color: COLORS.dim }}>사용 중 문서</div>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 24px" }}>
        <input ref={fileRef} type="file" multiple accept={GUIDE_ACCEPT} style={{ display: "none" }}
          onChange={(e) => { if (e.target.files?.length) onUpload(e.target.files); e.target.value = ""; }} />
        <div
          onClick={() => fileRef.current?.click()}
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7, padding: "26px 20px", border: "1px dashed rgba(255,255,255,.22)", borderRadius: 16, background: "rgba(255,255,255,.03)", cursor: "pointer" }}
        >
          <div style={{ fontSize: 14, fontWeight: 500 }}>랩 가이드 문서를 여기에 끌어다 놓기</div>
          <div style={{ fontSize: 12.5, color: COLORS.dim }}>md · pdf · txt · html · doc(x) · csv · xls(x) — 최대 50MB, 이미지는 3.75MB</div>
          <button style={{ marginTop: 5, height: 32, padding: "0 16px", border: 0, borderRadius: 999, background: COLORS.orange, color: COLORS.bgDark, font: "700 12.5px/1 inherit", cursor: "pointer" }}>
            파일 선택
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(240px,1fr) 96px 96px 74px", gap: "0 12px", padding: "16px 4px 10px", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "rgba(255,255,255,.35)", borderBottom: `1px solid ${COLORS.border}` }}>
          <div>문서</div><div>크기</div><div>상태</div><div></div>
        </div>
        {docs.map((d) => (
          <div key={d.key} style={{ display: "grid", gridTemplateColumns: "minmax(240px,1fr) 96px 96px 74px", gap: "0 12px", alignItems: "center", padding: "12px 4px", borderBottom: "1px solid rgba(255,255,255,.055)" }}>
            <div style={{ minWidth: 0, fontFamily: "ui-monospace,Menlo,monospace", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</div>
            <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5, color: "rgba(255,255,255,.6)" }}>{(d.sizeBytes / 1024).toFixed(0)} KB</div>
            <div>
              <button onClick={() => onToggle(d.key)} style={{ display: "flex", alignItems: "center", gap: 8, border: 0, background: "transparent", cursor: "pointer", padding: 0, font: "500 12px/1 inherit", color: d.active ? "#FFB84D" : "rgba(255,255,255,.4)" }}>
                <span style={{ width: 30, height: 17, borderRadius: 999, background: d.active ? COLORS.orange : "rgba(255,255,255,.18)", position: "relative", flex: "none" }}>
                  <span style={{ position: "absolute", top: 2, left: d.active ? 15 : 2, width: 13, height: 13, borderRadius: "50%", background: "#fff" }} />
                </span>
                {d.active ? "사용 중" : "제외"}
              </button>
            </div>
            <div>
              <button onClick={() => onDelete(d.key)} style={{ height: 26, padding: "0 11px", border: "1px solid rgba(255,255,255,.16)", borderRadius: 999, background: "transparent", color: "rgba(255,255,255,.6)", font: "500 11.5px/1 inherit", cursor: "pointer" }}>
                삭제
              </button>
            </div>
          </div>
        ))}
        {docs.length === 0 && <div style={{ padding: "16px 4px", color: COLORS.dim, fontSize: 13 }}>업로드된 문서가 없습니다.</div>}
      </div>
    </div>
  );
}

// ---------- Attendance ----------

function AttendanceView({ attendance, onResend }: { attendance: Attendance | null; onResend: (n: NoShow) => void }) {
  if (!attendance) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: "none", padding: "16px 20px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>참여 현황 · 아직 입장 안 한 참가자</div>
        <div style={{ fontSize: 12.5, color: COLORS.dim }}>입장하지 않은 참가자는 조인 링크를 재전송하세요.</div>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <div style={{ flex: 1, padding: "12px 14px", borderRadius: 12, background: "rgba(255,255,255,.04)", border: `1px solid ${COLORS.border}` }}>
            <div style={{ fontSize: 11, color: COLORS.dim, marginBottom: 5 }}>예상 참가자</div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{attendance.expectedCount}</div>
          </div>
          <div style={{ flex: 1, padding: "12px 14px", borderRadius: 12, background: "rgba(255,255,255,.04)", border: `1px solid ${COLORS.border}` }}>
            <div style={{ fontSize: 11, color: COLORS.dim, marginBottom: 5 }}>입장 완료</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.tealText }}>{attendance.joinedCount}</div>
          </div>
          <div style={{ flex: 1, padding: "12px 14px", borderRadius: 12, background: "rgba(221,52,76,.14)", border: "1px solid rgba(221,52,76,.45)" }}>
            <div style={{ fontSize: 11, color: COLORS.redText, marginBottom: 5 }}>미입장</div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{attendance.noShowCount}</div>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 24px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "150px 1fr 96px", gap: "0 14px", padding: "11px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "rgba(255,255,255,.35)", borderBottom: `1px solid ${COLORS.border}`, marginTop: 8 }}>
          <div>참가자 ID</div><div></div><div></div>
        </div>
        {attendance.noShows.map((n) => (
          <div key={n.participantId} style={{ display: "grid", gridTemplateColumns: "150px 1fr 96px", gap: "0 14px", alignItems: "center", padding: "11px 4px", borderBottom: "1px solid rgba(255,255,255,.055)", fontSize: 13.5 }}>
            <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5, color: "rgba(255,255,255,.7)" }}>{n.participantId}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: COLORS.redText }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.redText }} />미입장
            </div>
            <div><button onClick={() => onResend(n)} style={{ height: 26, padding: "0 11px", border: "1px solid rgba(255,255,255,.18)", borderRadius: 999, background: "transparent", color: "rgba(255,255,255,.8)", font: "500 11.5px/1 inherit", cursor: "pointer" }}>링크 재전송</button></div>
          </div>
        ))}
        {attendance.noShows.length === 0 && <div style={{ padding: "16px 4px", color: COLORS.dim, fontSize: 13 }}>모든 참가자가 입장했습니다.</div>}
      </div>
    </div>
  );
}

// ---------- Main ----------

export default function Operator({ onLogout }: { onLogout: () => void }) {
  const [labStep, setLabStepState] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [view, setView] = useState<View>("questions");
  const [activeChannel, setActiveChannel] = useState<string>("");
  const [channelThread, setChannelThread] = useState<Message | null>(null);
  const [questions, setQuestions] = useState<Message[]>([]);
  const [filter, setFilter] = useState<"open" | "all" | "top">("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [aiQueries, setAiQueries] = useState<AiQuery[]>([]);
  const [docs, setDocs] = useState<GuideDoc[]>([]);
  const [reindex, setReindex] = useState<{ status: string | null; startedAt?: string }>({ status: null });
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [exportRowCounts, setExportRowCounts] = useState<Record<string, number> | null>(null);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<any>(null);
  const [sidebarWidth, resizeSidebar] = useResizableWidth("wc:opSidebarWidth", 264, 200, 460);
  const [threadWidth, resizeThread] = useResizableWidth("wc:opThreadWidth", 392, 280, 720);

  function showToast(msg: string) {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }

  async function loadQuestions(chans: Channel[]) {
    const perChannel = await Promise.all(chans.map((c) => api.messages(c.pk.replace("CHANNEL#", ""))));
    const all = perChannel.flatMap((r) => r.messages);
    setQuestions(all.filter((m) => m.kind === "question" && !m.deleted));
  }

  async function refresh() {
    const [step, chans, exportStatus] = await Promise.all([api.labStep(), api.channels(), api.exportStatus()]);
    setLabStepState(step.step);
    setChannels(chans.channels);
    setLastExport(exportStatus.lastExportAt);
    setExportRowCounts(exportStatus.rowCounts);
    await loadQuestions(chans.channels);
  }

  useEffect(() => {
    refresh();
    api.attendance().then(setAttendance);
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (view === "ai") api.aiQueries().then((r) => setAiQueries(r.queries));
    if (view === "docs") {
      api.guideDocs().then((r) => setDocs(r.docs));
      api.reindexStatus().then(setReindex);
    }
    if (view === "attendance") api.attendance().then(setAttendance);
  }, [view]);

  const selected = useMemo(() => questions.find((q) => q.sk.replace("MSG#", "") === selectedId) ?? null, [questions, selectedId]);
  const openCount = questions.filter((q) => q.status === "open").length;

  async function exportNow() {
    if (exporting) return;
    setExporting(true);
    try {
      await api.exportNow();
      const status = await api.exportStatus();
      setLastExport(status.lastExportAt);
      setExportRowCounts(status.rowCounts);
      showToast("xlsx 내보내기 완료");
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
        showToast(`${file.name} 업로드 실패: ${err.message}`);
        continue;
      }
    }
    await api.markGuideDocUploaded();
    setDocs((await api.guideDocs()).docs);
    showToast("업로드 완료 · 재인덱싱이 필요합니다");
  }

  const channelName = (slug: string) => channels.find((c) => c.pk.replace("CHANNEL#", "") === slug)?.name ?? slug;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: COLORS.bg, color: "#fff", fontSize: 14, overflow: "hidden" }}>
      {/* Top bar */}
      <div style={{ height: 56, flex: "none", display: "flex", alignItems: "center", gap: 16, padding: "0 16px", background: COLORS.bgDark, borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, width: 248, flex: "none" }}>
          <div style={{ width: 26, height: 26, borderRadius: 6, background: COLORS.orange, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, color: COLORS.bgDark }}>W</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Workshop Chat · 운영자</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: COLORS.dim, textTransform: "uppercase", fontWeight: 700 }}>현재 랩 스텝</span>
          <input
            value={labStep}
            onChange={(e) => setLabStepState(e.target.value)}
            onBlur={() => api.setLabStep(labStep)}
            onKeyDown={(e) => e.key === "Enter" && api.setLabStep(labStep)}
            style={{ height: 32, padding: "0 12px", border: "1px solid rgba(255,153,0,.5)", borderRadius: 8, background: "rgba(255,153,0,.12)", color: "#fff", font: "500 13px/1 inherit" }}
          />
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
            <div style={{ fontSize: 11, color: COLORS.dim }}>마지막 내보내기</div>
            <div style={{ fontSize: 12, fontFamily: "ui-monospace,Menlo,monospace" }}>{lastExport ? timeLabel(lastExport) : "아직 없음"}</div>
            {exportRowCounts && (
              // Evidence the export isn't silently truncated (DynamoDB's 1MB page cap) — matches
              // the Meta sheet inside the xlsx itself, so what's on screen is what's in the file.
              <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)", fontFamily: "ui-monospace,Menlo,monospace" }}>
                Q{exportRowCounts.Questions} · AI{exportRowCounts.AI_Queries} · P{exportRowCounts.Participants} · T{exportRowCounts.Timeline}
              </div>
            )}
          </div>
          <button onClick={exportNow} disabled={exporting} style={{ height: 34, padding: "0 18px", border: 0, borderRadius: 999, background: COLORS.orange, color: COLORS.bgDark, font: "700 13px/1 inherit", cursor: "pointer" }}>
            {exporting ? "내보내는 중…" : "지금 내보내기"}
          </button>
          <a href="/api/export"><button style={{ height: 34, padding: "0 14px", border: "1px solid rgba(255,255,255,.2)", borderRadius: 999, background: "transparent", color: "#fff", cursor: "pointer" }}>다운로드</button></a>
          <div style={{ width: 1, height: 24, background: "rgba(255,255,255,.12)" }} />
          <button onClick={onLogout} style={{ height: 34, padding: "0 14px", border: "1px solid rgba(255,255,255,.2)", borderRadius: 999, background: "transparent", color: "#fff", cursor: "pointer" }}>로그아웃</button>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0, overflowX: "auto" }}>
        {/* Sidebar */}
        <div style={{ width: sidebarWidth, flex: "none", background: COLORS.bgDark, borderRight: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", overflowY: "auto" }}>
          <div
            onClick={() => setView("attendance")}
            style={{ margin: "14px 12px 8px", padding: 12, borderRadius: 12, background: "rgba(221,52,76,.14)", border: "1px solid rgba(221,52,76,.45)", cursor: "pointer" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 9 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: COLORS.redText }}>아직 입장 안 한 참가자</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 30, fontWeight: 700, lineHeight: 1 }}>{attendance?.noShowCount ?? "—"}</span>
              <span style={{ fontSize: 13, color: "rgba(255,255,255,.6)" }}>/ {attendance?.expectedCount ?? "—"}</span>
            </div>
            <div style={{ marginTop: 9, fontSize: 11.5, color: COLORS.orange, fontWeight: 500 }}>확인 →</div>
          </div>

          <div style={{ padding: "10px 12px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: "rgba(255,255,255,.35)" }}>채널</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 8px" }}>
            {channels.filter((c) => !c.archived).map((c) => {
              const slug = c.pk.replace("CHANNEL#", "");
              return (
                <NavItem
                  key={slug}
                  icon="#" iconColor="rgba(255,255,255,.35)" label={c.name}
                  active={view === "channel" && activeChannel === slug}
                  onClick={() => { setView("channel"); setActiveChannel(slug); setChannelThread(null); }}
                />
              );
            })}
          </div>

          <div style={{ padding: "16px 12px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: "rgba(255,255,255,.35)" }}>운영</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 8px 16px" }}>
            <NavItem icon="◗" iconColor={COLORS.orange} label="질문 보드" count={`${openCount} open`} active={view === "questions"} onClick={() => setView("questions")} />
            <NavItem icon="✳" iconColor={COLORS.teal} label="AI 도우미 로그" count={aiQueries.length || undefined} active={view === "ai"} onClick={() => setView("ai")} />
            <NavItem icon="▤" iconColor="rgba(255,255,255,.5)" label="랩 가이드 문서" badge="운영자 전용" active={view === "docs"} onClick={() => setView("docs")} />
            <NavItem icon="◎" iconColor="rgba(255,255,255,.5)" label="참여 현황" active={view === "attendance"} onClick={() => setView("attendance")} />
          </div>

          <div style={{ flex: 1 }} />
          <div style={{ margin: "0 12px 14px", padding: "11px 12px", borderRadius: 12, background: "rgba(255,255,255,.04)" }}>
            <div style={{ fontSize: 11, color: COLORS.dim, lineHeight: 1.5 }}>
              워크샵 계정은 언젠가 삭제됩니다. 종료 전 xlsx를 반드시 다운로드하세요.
            </div>
          </div>
        </div>
        <Resizer onResize={resizeSidebar} />

        {/* Main */}
        <div style={{ flex: 1, minWidth: 540, display: "flex", flexDirection: "column", background: COLORS.bg }}>
          {view === "questions" && (
            <QuestionsView
              questions={questions} filter={filter} setFilter={setFilter} selectedId={selectedId} setSelectedId={setSelectedId}
              onUpvote={(q) => api.upvote(q.channel, q.sk.replace("MSG#", "")).then(() => loadQuestions(channels))}
              onResolve={(q) => api.resolve(q.channel, q.sk.replace("MSG#", "")).then(() => { loadQuestions(channels); showToast("해결로 표시했습니다"); })}
              onDelete={(q) => api.deleteMessage(q.channel, q.sk.replace("MSG#", "")).then(() => { loadQuestions(channels); showToast("메시지를 삭제했습니다"); })}
            />
          )}
          {view === "channel" && activeChannel && <ChannelView slug={activeChannel} name={channelName(activeChannel)} onOpenThread={setChannelThread} />}
          {view === "ai" && <AiLogView queries={aiQueries} />}
          {view === "docs" && (
            <DocsView
              docs={docs} reindexStatus={reindex} onUpload={uploadGuideDocs}
              onToggle={(key) => api.toggleGuideDoc(key).then(() => api.guideDocs().then((r) => setDocs(r.docs)))}
              onDelete={(key) => api.deleteGuideDoc(key).then(() => { api.guideDocs().then((r) => setDocs(r.docs)); showToast("문서를 삭제했습니다"); })}
              onReindex={() => api.reindexGuideDocs().then((r) => { setReindex(r); showToast("재인덱싱을 시작했습니다"); }).catch((err) => showToast(err.message))}
            />
          )}
          {view === "attendance" && (
            <AttendanceView
              attendance={attendance}
              onResend={(n) => api.resendJoinLink(n.participantId).then(() => showToast(`${n.participantId} 조인 링크를 재전송했습니다`))}
            />
          )}
        </div>

        {selected && view === "questions" && (
          <ThreadPanel channel={selected.channel} ulid={selected.sk.replace("MSG#", "")} message={selected} onClose={() => setSelectedId(null)} width={threadWidth} onResize={resizeThread} />
        )}
        {channelThread && view === "channel" && (
          <ThreadPanel channel={channelThread.channel} ulid={channelThread.sk.replace("MSG#", "")} message={channelThread} onClose={() => setChannelThread(null)} width={threadWidth} onResize={resizeThread} />
        )}
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", background: "#232F3E", border: "1px solid rgba(255,255,255,.14)", borderRadius: 10, padding: "10px 18px", fontSize: 13, boxShadow: "0 4px 20px rgba(0,7,22,.5)" }}>
          {toast}
        </div>
      )}
    </div>
  );
}
