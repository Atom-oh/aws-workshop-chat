import { useState } from "react";
import { api } from "./api";
import { COLORS } from "./theme";
import { useLocale, LocaleToggle } from "./i18n";

// §5.4 fallback UI. The primary path (§5.4 one-click /j link) never renders this component —
// the browser is already redirected and cookie'd before React even mounts. One form for both
// participant and operator accounts — role comes back from Cognito group membership, not from
// picking a login type up front.
export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const { t } = useLocale();
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set by a redirect from GET /j when the one-click join link is missing/expired/tampered —
  // that's the primary entry point for most participants, so landing here needs to read as
  // "use ID/password instead", not a dead end.
  const expiredLink = new URLSearchParams(window.location.search).get("error") === "expired_link";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.loginId(id, password);
      onLoggedIn();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", border: "1px solid rgba(255,255,255,.16)", borderRadius: 8, padding: "9px 11px",
    fontSize: 14, background: "rgba(255,255,255,.05)", color: "#fff",
  };
  const labelStyle: React.CSSProperties = { display: "block", fontSize: 12.5, color: COLORS.dim, marginBottom: 5 };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: COLORS.bg, color: "#fff" }}>
      <div style={{ width: 380, background: COLORS.bgDark, border: `1px solid ${COLORS.border}`, borderRadius: 16, padding: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: COLORS.orange, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 15, color: COLORS.bgDark }}>W</div>
          <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>Workshop Chat</h2>
          <LocaleToggle />
        </div>
        <p style={{ fontSize: 12.5, color: COLORS.dim, lineHeight: 1.5, marginBottom: 16 }}>
          {t("참가자 간에는 익명입니다. 운영자는 참가자에게 발급된 참가자 ID를 확인할 수 있습니다.")}
        </p>
        {expiredLink && (
          <p style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(var(--c-danger-rgb),.14)", border: "1px solid rgba(var(--c-danger-rgb),.35)", color: COLORS.redText, fontSize: 12.5, lineHeight: 1.5, marginBottom: 16 }}>
            {t("조인 링크가 만료되었거나 올바르지 않습니다. 아래 ID/비밀번호로 로그인해 주세요.")}
          </p>
        )}
        <form onSubmit={submit}>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>{t("ID (참가자 ID 또는 운영자 아이디)")}</label>
            <input
              style={inputStyle}
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="012345678901@ws / admin@ws"
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>{t("비밀번호")}</label>
            <input style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <p style={{ color: COLORS.redText, fontSize: 13 }}>{error}</p>}
          <button
            type="submit"
            disabled={busy}
            style={{ width: "100%", height: 38, border: 0, borderRadius: 999, background: COLORS.orange, color: COLORS.bgDark, fontWeight: 700, fontSize: 14, cursor: "pointer" }}
          >
            {t("입장")}
          </button>
        </form>
      </div>
    </div>
  );
}
