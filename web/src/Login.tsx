import { useState } from "react";
import { api } from "./api";

// §5.4 fallback UI. The primary path (§5.4 one-click /j link) never renders this component —
// the browser is already redirected and cookie'd before React even mounts.
export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [mode, setMode] = useState<"passphrase" | "password" | "operator">("passphrase");
  const [participantId, setParticipantId] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "passphrase") await api.loginPassphrase(participantId, secret);
      else if (mode === "password") await api.loginPassword(participantId, secret);
      else await api.loginOperator(secret);
      onLoggedIn();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 420, marginTop: 80 }}>
      <div className="card">
        <h2>Workshop Chat</h2>
        <p className="notice">
          참가자 간에는 익명입니다. 운영자는 참가자에게 발급된 참가자 ID를 확인할 수 있습니다.
        </p>
        <div className="tabs">
          <button className={mode === "passphrase" ? "active" : ""} onClick={() => setMode("passphrase")}>
            공용 패스프레이즈
          </button>
          <button className={mode === "password" ? "active" : ""} onClick={() => setMode("password")}>
            개별 비밀번호
          </button>
          <button className={mode === "operator" ? "active" : ""} onClick={() => setMode("operator")}>
            운영자
          </button>
        </div>
        <form onSubmit={submit}>
          {mode !== "operator" && (
            <div style={{ marginBottom: 8 }}>
              <label>참가자 ID</label>
              <input value={participantId} onChange={(e) => setParticipantId(e.target.value)} placeholder="123456789012" />
            </div>
          )}
          <div style={{ marginBottom: 8 }}>
            <label>{mode === "operator" ? "운영자 패스코드" : mode === "passphrase" ? "공용 패스프레이즈" : "비밀번호"}</label>
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </div>
          {error && <p style={{ color: "crimson" }}>{error}</p>}
          <button className="primary" type="submit" disabled={busy} style={{ width: "100%" }}>
            입장
          </button>
        </form>
      </div>
    </div>
  );
}
