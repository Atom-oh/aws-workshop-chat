import { useEffect, useRef, useState } from "react";
import { api, wsUrl, type Channel, type Message, type Session } from "./api";
import { avatarColor, renderBody } from "./format";

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function Composer({
  value,
  onChange,
  onSend,
  onPaste,
  placeholder,
  extra,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  extra?: React.ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  return (
    <div className="composer-wrap">
      {extra}
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
      />
      <div className="composer-footer">
        <span className="hint">Enter로 보내기 · Shift+Enter로 줄바꿈 · `code` · ```코드블록```</span>
        <button className="primary" onClick={onSend}>
          보내기
        </button>
      </div>
    </div>
  );
}

function MessageRow({
  m,
  children,
}: {
  m: { participantId: string; createdAt: string; body: string };
  children?: React.ReactNode;
}) {
  return (
    <div className="msg-row">
      <div className="avatar" style={{ background: avatarColor(m.participantId) }}>
        {m.participantId.slice(-2)}
      </div>
      <div className="msg-content">
        <div className="meta">
          <span className="msg-author">참가자 ...{m.participantId.slice(-4)}</span>
          <span className="msg-time">{timeLabel(m.createdAt)}</span>
        </div>
        <div className="body">{renderBody(m.body)}</div>
        {children}
      </div>
    </div>
  );
}

function Thread({ slug, rootUlid, onClose }: { slug: string; rootUlid: string; onClose: () => void }) {
  const [replies, setReplies] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    api.threadReplies(rootUlid).then((r) => setReplies(r.replies));
  }, [rootUlid]);

  async function send() {
    if (!draft.trim()) return;
    await api.postMessage(slug, draft, "msg", rootUlid);
    setDraft("");
    setReplies((await api.threadReplies(rootUlid)).replies);
  }

  return (
    <div className="card thread-card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>스레드</strong>
        <button onClick={onClose}>닫기</button>
      </div>
      {replies.map((r) => (
        <MessageRow key={r.sk} m={r} />
      ))}
      <Composer value={draft} onChange={setDraft} onSend={send} placeholder="답글 작성" />
    </div>
  );
}

export default function Chat({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [active, setActive] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [asQuestion, setAsQuestion] = useState(false);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [aiQuery, setAiQuery] = useState("");
  const [aiHistory, setAiHistory] = useState<{ query: string; answer: string; refDocs: string[] }[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    api.channels().then((r) => {
      const visible = r.channels.filter((c) => c.scaleVisible && !c.archived);
      setChannels(visible);
      if (visible.length && !active) setActive(visible[0].pk.replace("CHANNEL#", ""));
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    api.messages(active).then((r) => setMessages(r.messages));

    wsRef.current?.close();
    const ws = new WebSocket(wsUrl(active));
    ws.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      if (data.type === "message" && !data.message.threadId) {
        setMessages((prev) => [...prev, data.message]);
      } else if (data.type === "upvote") {
        setMessages((prev) => prev.map((m) => (m.sk === `MSG#${data.ulid}` ? { ...m, upvotes: data.upvotes } : m)));
      } else if (data.type === "resolved") {
        setMessages((prev) => prev.map((m) => (m.sk === `MSG#${data.ulid}` ? { ...m, status: "resolved" } : m)));
      } else if (data.type === "deleted") {
        setMessages((prev) => prev.map((m) => (m.sk === `MSG#${data.ulid}` ? { ...m, deleted: true } : m)));
      }
    };
    wsRef.current = ws;
    return () => ws.close();
  }, [active]);

  async function send() {
    if (!draft.trim()) return;
    const isQuestions = active === "questions";
    await api.postMessage(active, draft, isQuestions && asQuestion ? "question" : "msg");
    setDraft("");
    setMessages((await api.messages(active)).messages);
  }

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // ponytail: clipboard-image upload wires to the same presign endpoint the file picker would
    // use; kept minimal here (paste -> presign -> PUT -> append URL to draft) rather than a
    // separate dropzone component, since that's the one interaction §6.1 actually calls out.
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    const presign = await fetch("/api/uploads/presign", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: file.type, sizeBytes: file.size }),
    }).then((r) => r.json());
    if (presign.error) return;
    await fetch(presign.url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
    setDraft((d) => `${d}\n[image: ${presign.key}]`);
  }

  async function ask() {
    if (!aiQuery.trim()) return;
    setAiBusy(true);
    try {
      const result = await api.ask(aiQuery);
      setAiHistory((h) => [...h, { query: aiQuery, ...result }]);
      setAiQuery("");
    } catch (err: any) {
      setAiHistory((h) => [...h, { query: aiQuery, answer: `오류: ${err.message}`, refDocs: [] }]);
    } finally {
      setAiBusy(false);
    }
  }

  const sorted = active === "questions" ? [...messages].sort((a, b) => (b.upvotes ?? 0) - (a.upvotes ?? 0)) : messages;

  return (
    <div className="container">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <strong>Workshop Chat</strong>
        <div className="row">
          <span style={{ fontSize: 13, color: "#667085" }}>
            {session.role === "operator" ? "운영자" : `참가자 ...${session.participantId.slice(-4)}`}
          </span>
          <button onClick={onLogout}>로그아웃</button>
        </div>
      </div>

      <div className="tabs">
        {channels.map((c) => {
          const slug = c.pk.replace("CHANNEL#", "");
          return (
            <button key={slug} className={active === slug ? "active" : ""} onClick={() => setActive(slug)}>
              {c.name}
            </button>
          );
        })}
      </div>

      <div className="card">
        {sorted.filter((m) => !m.deleted).map((m) => (
          <div key={m.sk}>
            <MessageRow m={m}>
              {m.kind === "question" && (
                <span className={`badge ${m.status === "resolved" ? "resolved" : ""}`}>
                  {m.status === "resolved" ? "해결됨" : "미해결"} · 👍{m.upvotes}
                </span>
              )}
              <div className="msg-actions">
                <button onClick={() => setOpenThread(openThread === m.sk ? null : m.sk.replace("MSG#", ""))}>스레드</button>
                {m.kind === "question" && <button onClick={() => api.upvote(active, m.sk.replace("MSG#", ""))}>👍</button>}
                {m.kind === "question" && session.role === "operator" && m.status !== "resolved" && (
                  <button onClick={() => api.resolve(active, m.sk.replace("MSG#", ""))}>해결로 표시</button>
                )}
                {session.role === "operator" && (
                  <button onClick={() => api.deleteMessage(active, m.sk.replace("MSG#", ""))}>삭제</button>
                )}
              </div>
            </MessageRow>
            {openThread === m.sk.replace("MSG#", "") && (
              <Thread slug={active} rootUlid={m.sk.replace("MSG#", "")} onClose={() => setOpenThread(null)} />
            )}
          </div>
        ))}

        {active === "questions" && (
          <label className="row checkbox-row">
            <input type="checkbox" style={{ width: "auto" }} checked={asQuestion} onChange={(e) => setAsQuestion(e.target.checked)} />
            질문으로 등록
          </label>
        )}
        <Composer value={draft} onChange={setDraft} onSend={send} onPaste={onPaste} placeholder="메시지 입력 (이미지 붙여넣기 가능)" />
      </div>

      <div className="card">
        <strong>AI 챗</strong>
        <p style={{ fontSize: 13, color: "#667085" }}>답변은 본인에게만 표시됩니다.</p>
        {aiHistory.map((h, i) => (
          <div key={i} className="msg">
            <div className="meta">질문: {h.query}</div>
            <div className="body">{renderBody(h.answer)}</div>
            {h.refDocs.length > 0 && <div className="meta">참고: {h.refDocs.join(", ")}</div>}
          </div>
        ))}
        <div className="row" style={{ marginTop: 8 }}>
          <input value={aiQuery} onChange={(e) => setAiQuery(e.target.value)} placeholder="랩 가이드에 대해 질문하기" onKeyDown={(e) => e.key === "Enter" && ask()} />
          <button className="primary" disabled={aiBusy} onClick={ask}>
            질문
          </button>
        </div>
      </div>
    </div>
  );
}
