import { useEffect, useRef, useState } from "react";

// Shareable, refresh-safe view state — no router dependency needed since this app only ever has
// two real paths ("/" and "/operator"); everything else (active channel, open thread, which
// sub-view) lives in the query string of whichever path you're already on, kept in sync via the
// native History API. `readParams` is read once per mount for the initial state; `setParams`
// replaces the URL (no new history entry per click — this is chat, not document navigation) with
// exactly the keys passed, so switching views can't leave a stale param from the previous one.
export function readParams(): URLSearchParams {
  return new URLSearchParams(location.search);
}

export function setParams(patch: Record<string, string | null | undefined>) {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(patch)) {
    if (value) next.set(key, value);
  }
  const qs = next.toString();
  const url = `${location.pathname}${qs ? `?${qs}` : ""}`;
  if (url !== location.pathname + location.search) history.replaceState(null, "", url);
}

// A permalink to one specific message — Slack-style: channel/view state carries the reader to
// the right screen (readParams/setParams above), this carries them to the right *row* on it.
// Root messages, thread roots, and thread replies all share the same `MSG#<ulid>` sk shape, so
// one generic helper covers the channel timeline, the questions board, and both thread panels —
// just point it at whichever list is currently rendered.
export function buildMessageLink(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) q.set(key, value);
  return `${location.origin}${location.pathname}?${q.toString()}`;
}

// Scrolls to and briefly flashes the row matching `targetUlid` once it shows up in `list` —
// fires once per mount (a `firedRef` guard, not a dep-driven re-check) so it doesn't refire on
// every re-render while the list is still loading in, and it doesn't chase a channel switch that
// happens after the initial deep link resolved. Pair with `data-msg-anchor={ulid}` on the row and
// check the returned value to apply a highlight style.
export function useHighlight<T extends { sk: string }>(list: T[], targetUlid: string | null | undefined): string | null {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current || !targetUlid) return;
    if (!list.some((item) => item.sk === `MSG#${targetUlid}`)) return;
    firedRef.current = true;
    document.querySelector(`[data-msg-anchor="${targetUlid}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlighted(targetUlid);
    const timer = setTimeout(() => setHighlighted(null), 2200);
    return () => clearTimeout(timer);
  }, [list, targetUlid]);
  return highlighted;
}
