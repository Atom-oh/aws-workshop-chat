import { useEffect, useState } from "react";
import { api, type Session } from "./api";
import Login from "./Login";
import Chat from "./Chat";
import Operator from "./Operator";

export default function App() {
  const [session, setSession] = useState<Session | null | "loading">("loading");

  async function refreshSession() {
    setSession((await api.session()).session);
  }

  useEffect(() => {
    refreshSession();
  }, []);

  if (session === "loading") return null;
  if (!session) return <Login onLoggedIn={refreshSession} />;

  const onOperatorRoute = location.pathname === "/operator";
  if (onOperatorRoute && session.role !== "operator") {
    return (
      <div className="container">
        <p>운영자만 접근할 수 있습니다.</p>
      </div>
    );
  }

  async function onLogout() {
    await api.logout();
    setSession(null);
  }

  return onOperatorRoute ? <Operator onLogout={onLogout} /> : <Chat session={session} onLogout={onLogout} />;
}
