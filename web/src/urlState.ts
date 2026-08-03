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
