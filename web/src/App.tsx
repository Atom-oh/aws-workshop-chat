import { useCallback, useEffect, useState } from "react";
import { api, type ParticipantAuthMode, type Session } from "./api";
import Login from "./Login";
import Chat from "./Chat";
import Operator from "./Operator";
import { LocaleProvider, LocaleToggle, useLocale } from "./i18n";
import { COLORS } from "./theme";

function AppInner() {
  const [session, setSession] = useState<Session | null | "loading">("loading");
  const [participantAuthMode, setParticipantAuthMode] = useState<ParticipantAuthMode>("cognito");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const { t } = useLocale();

  const refreshSession = useCallback(async (afterLogin = false) => {
    setSessionError(null);
    setSession("loading");
    try {
      const result = await api.session();
      if (afterLogin && result.session?.role === "operator" && location.pathname !== "/operator") {
        history.replaceState(null, "", "/operator");
      }
      setParticipantAuthMode(result.participantAuthMode);
      setSession(result.session);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  if (session === "loading") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ width: 380, maxWidth: "100%", padding: 28, background: COLORS.bgDark, border: `1px solid ${COLORS.border}`, borderRadius: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <h2 style={{ fontSize: 18 }}>Workshop Chat</h2>
            <LocaleToggle />
          </div>
          {sessionError ? (
            <>
              <p role="alert" style={{ color: COLORS.redText, fontSize: 13, overflowWrap: "anywhere" }}>
                {t("세션을 불러오지 못했습니다. 다시 시도해 주세요.")} {sessionError}
              </p>
              <button onClick={() => void refreshSession(true)} style={{ width: "100%", height: 38, border: 0, borderRadius: 999, background: COLORS.orange, color: COLORS.bgDark, fontWeight: 700 }}>
                {t("다시 시도")}
              </button>
            </>
          ) : <p role="status" style={{ color: COLORS.dim, fontSize: 13 }}>{t("불러오는 중…")}</p>}
        </div>
      </div>
    );
  }
  const onOperatorRoute = location.pathname === "/operator";
  if (!session) return <Login participantAuthMode={participantAuthMode} operatorRoute={onOperatorRoute} onLoggedIn={() => refreshSession(true)} />;

  async function onLogout() {
    await api.logout();
    setSession(null);
  }

  if (onOperatorRoute && session.role !== "operator") {
    return (
      <div className="container">
        <p>{t("운영자만 접근할 수 있습니다.")}</p>
        <p><a href="/">{t("참가자 입장으로 돌아가기")}</a></p>
        <button onClick={onLogout}>{t("로그아웃")}</button>
      </div>
    );
  }

  return onOperatorRoute ? <Operator onLogout={onLogout} /> : <Chat session={session} onLogout={onLogout} />;
}

export default function App() {
  return (
    <LocaleProvider>
      <AppInner />
    </LocaleProvider>
  );
}
