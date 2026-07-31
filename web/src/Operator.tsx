import { useEffect, useState } from "react";
import { api } from "./api";

export default function Operator() {
  const [labStep, setLabStepState] = useState("");
  const [labStepDraft, setLabStepDraft] = useState("");
  const [openQuestions, setOpenQuestions] = useState<any[]>([]);
  const [participants, setParticipants] = useState<any[]>([]);
  const [roster, setRoster] = useState<{ participantId: string; joinUrl: string }[]>([]);
  const [passphrase, setPassphrase] = useState("");
  const [lastExportAt, setLastExportAt] = useState<string | null>(null);

  async function refresh() {
    const [step, questions, ps, exportStatus] = await Promise.all([
      api.labStep(),
      api.questions("open"),
      api.participants(),
      api.exportStatus(),
    ]);
    setLabStepState(step.step);
    setLabStepDraft(step.step);
    setOpenQuestions(questions.questions);
    setParticipants(ps.participants);
    setLastExportAt(exportStatus.lastExportAt);
  }

  useEffect(() => {
    refresh();
    api.roster().then((r) => {
      setRoster(r.roster);
      setPassphrase(r.participantPassphrase);
    });
    const interval = setInterval(refresh, 15_000); // §6.1: operator screen optimizes for "who's stuck right now"
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="container">
      <h2>운영자 콘솔</h2>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>지금 내보내기</strong>
          <span style={{ fontSize: 13, color: "#667085" }}>
            마지막 내보내기: {lastExportAt ? new Date(lastExportAt).toLocaleString("ko-KR") : "아직 없음"}
          </span>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="primary"
            onClick={async () => {
              await api.exportNow();
              setLastExportAt((await api.exportStatus()).lastExportAt);
            }}
          >
            지금 내보내기
          </button>
          <a href="/api/export"><button>xlsx 다운로드</button></a>
        </div>
        <p className="notice" style={{ marginTop: 8 }}>
          계정 소멸 전 다운로드하지 않으면 데이터는 사라집니다.
        </p>
      </div>

      <div className="card">
        <strong>현재 랩 스텝</strong>
        <div className="row" style={{ marginTop: 8 }}>
          <input value={labStepDraft} onChange={(e) => setLabStepDraft(e.target.value)} />
          <button
            className="primary"
            onClick={async () => {
              await api.setLabStep(labStepDraft);
              setLabStepState(labStepDraft);
            }}
          >
            업데이트
          </button>
        </div>
        <p style={{ fontSize: 13, color: "#667085" }}>현재: {labStep}</p>
      </div>

      <div className="card">
        <strong>미해결 질문 ({openQuestions.length})</strong>
        <table>
          <thead>
            <tr><th>채널</th><th>질문</th><th>업보트</th><th>랩 스텝</th><th></th></tr>
          </thead>
          <tbody>
            {openQuestions.map((q) => (
              <tr key={q.sk}>
                <td>{q.channel}</td>
                <td>{q.body}</td>
                <td>{parseInt(q.sk.split("#")[0], 10)}</td>
                <td>{q.labStep}</td>
                <td>
                  <button onClick={() => api.resolve(q.channel, q.messageId).then(refresh)}>해결</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <strong>참가자 ({participants.length})</strong>
        <table>
          <thead>
            <tr><th>참가자 ID</th><th>질문</th><th>AI 쿼리</th><th>차단</th></tr>
          </thead>
          <tbody>
            {participants.map((p) => (
              <tr key={p.participantId}>
                <td>{p.participantId}</td>
                <td>{p.questionCount}</td>
                <td>{p.aiQueryCount}</td>
                <td>
                  {p.blocked ? (
                    <button onClick={() => api.unblock(p.participantId).then(refresh)}>차단 해제</button>
                  ) : (
                    <button onClick={() => api.block(p.participantId).then(refresh)}>차단</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>참가자 조인 링크 ({roster.length})</strong>
          <a href="/api/operator/roster.csv"><button>CSV 다운로드</button></a>
        </div>
        <p style={{ fontSize: 13, color: "#667085" }}>
          SSM 실패 시 폴백 패스프레이즈: <code>{passphrase}</code>
        </p>
        <table>
          <thead><tr><th>참가자 ID</th><th>조인 링크</th></tr></thead>
          <tbody>
            {roster.slice(0, 20).map((r) => (
              <tr key={r.participantId}>
                <td>{r.participantId}</td>
                <td><a href={r.joinUrl}>{r.joinUrl}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
        {roster.length > 20 && <p style={{ fontSize: 13 }}>… 나머지는 CSV로 다운로드하세요 ({roster.length - 20}건 더)</p>}
      </div>
    </div>
  );
}
