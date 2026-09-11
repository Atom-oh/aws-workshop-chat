import { useState } from "react";
import { api, type ParticipantAuthMode } from "./api";
import { COLORS } from "./theme";
import { useLocale, LocaleToggle } from "./i18n";

const LOGIN_ERRORS: Record<string, string> = {
  "nickname must be between 1 and 20 characters": "닉네임은 앞뒤 공백을 제외하고 1~20자로 입력해 주세요.",
  "nickname contains unsupported characters": "닉네임에 제어 문자나 보이지 않는 형식 문자를 사용할 수 없습니다.",
  "nickname is reserved": "운영자 또는 관리자용 닉네임은 사용할 수 없습니다.",
  "nickname login is disabled": "닉네임 입장이 비활성화되었습니다. 페이지를 새로고침해 주세요.",
  "participant is blocked": "차단된 참가자입니다. 운영자에게 문의해 주세요.",
};

export default function Login({ participantAuthMode, operatorRoute, onLoggedIn }: {
  participantAuthMode: ParticipantAuthMode;
  operatorRoute: boolean;
  onLoggedIn: () => Promise<void>;
}) {
  const { t } = useLocale();
  const nicknameEntry = participantAuthMode === "nickname" && !operatorRoute;
  const [nickname, setNickname] = useState("");
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The server redirects invalid or expired one-click join links here.
  const expiredLink = new URLSearchParams(window.location.search).get("error") === "expired_link";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (nicknameEntry) await api.loginNickname(nickname);
      else await api.loginId(id, password);
      await onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: COLORS.bg, color: "#fff" }}>
      <div style={{ width: 380, maxWidth: "100%", background: COLORS.bgDark, border: `1px solid ${COLORS.border}`, borderRadius: 16, padding: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: COLORS.orange, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 15, color: COLORS.bgDark }}>W</div>
          <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>Workshop Chat</h2>
          <LocaleToggle />
        </div>
        <p style={{ fontSize: 12.5, color: COLORS.dim, lineHeight: 1.5, marginBottom: 16 }}>
          {nicknameEntry
            ? t("워크샵에서 사용할 닉네임을 입력하세요. 닉네임은 다른 참가자에게 표시됩니다.")
            : operatorRoute ? t("운영자 ID와 비밀번호로 로그인하세요.")
              : t("참가자 간에는 익명입니다. 운영자는 참가자에게 발급된 참가자 ID를 확인할 수 있습니다.")}
        </p>
        {expiredLink && (
          <p style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(var(--c-danger-rgb),.14)", border: "1px solid rgba(var(--c-danger-rgb),.35)", color: COLORS.redText, fontSize: 12.5, lineHeight: 1.5, marginBottom: 16 }}>
            {nicknameEntry
              ? t("조인 링크가 만료되었거나 올바르지 않습니다. 아래 닉네임으로 입장해 주세요.")
              : t("조인 링크가 만료되었거나 올바르지 않습니다. 아래 ID/비밀번호로 로그인해 주세요.")}
          </p>
        )}
        <form onSubmit={submit}>
          {nicknameEntry ? (
            <div style={{ marginBottom: 14 }}>
              <label htmlFor="nickname" style={labelStyle}>{t("닉네임")}</label>
              <input
                id="nickname"
                name="nickname"
                autoComplete="nickname"
                aria-describedby="nickname-hint"
                style={inputStyle}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                required
                disabled={busy}
              />
              <p id="nickname-hint" style={{ fontSize: 12, color: COLORS.dim, lineHeight: 1.5, marginBottom: 0 }}>
                {t("1~20자. 운영자·관리자 이름과 제어·형식 문자는 사용할 수 없습니다.")}
              </p>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 12 }}>
                <label htmlFor="login-id" style={labelStyle}>{operatorRoute ? t("운영자 ID") : t("ID (참가자 ID 또는 운영자 아이디)")}</label>
                <input
                  id="login-id"
                  autoComplete="username"
                  style={inputStyle}
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder={operatorRoute ? "admin@ws" : "012345678901@ws / admin@ws"}
                  disabled={busy}
                />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label htmlFor="login-password" style={labelStyle}>{t("비밀번호")}</label>
                <input id="login-password" autoComplete="current-password" style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
              </div>
            </>
          )}
          {error && <p role="alert" style={{ color: COLORS.redText, fontSize: 13 }}>{t(LOGIN_ERRORS[error] ?? error)}</p>}
          <button
            type="submit"
            disabled={busy}
            style={{ width: "100%", height: 38, border: 0, borderRadius: 999, background: COLORS.orange, color: COLORS.bgDark, fontWeight: 700, fontSize: 14, cursor: "pointer" }}
          >
            {busy ? t("입장 중…") : t("입장")}
          </button>
        </form>
        <div style={{ marginTop: 16, textAlign: "center" }}>
          <a href={operatorRoute ? "/" : "/operator"} style={{ color: COLORS.orange, fontSize: 12.5 }}>
            {operatorRoute ? t("참가자 입장으로 돌아가기") : t("운영자 로그인")}
          </a>
        </div>
      </div>
    </div>
  );
}
