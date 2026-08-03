import { useEffect, useState } from "react";
import { api, type Session } from "./api";
import Login from "./Login";
import Chat from "./Chat";
import Operator from "./Operator";
import { LocaleProvider, useLocale } from "./i18n";

function AppInner() {
  const [session, setSession] = useState<Session | null | "loading">("loading");
  const { t } = useLocale();

  async function refreshSession() {
    setSession((await api.session()).session);
  }

  useEffect(() => {
    refreshSession();
  }, []);

  if (session === "loading") return null;
  if (!session) return <Login onLoggedIn={refreshSession} />;

  async function onLogout() {
    await api.logout();
    setSession(null);
  }

  const onOperatorRoute = location.pathname === "/operator";
  if (onOperatorRoute && session.role !== "operator") {
    return (
      <div className="container">
        <p>{t("운영자만 접근할 수 있습니다.")}</p>
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
