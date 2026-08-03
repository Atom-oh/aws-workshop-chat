// Deterministic per-participant avatar color — same idea as Slack's generated-color avatars.
export function avatarColor(id: string): string {
  if (id === "operator") return "#DD344C";
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash}, 55%, 42%)`;
}

// Participant IDs are shaped "<12-digit-number>@ws" — strip the suffix before slicing so the
// displayed/initial digits are the distinguishing account-id digits, not literally "@ws" (which
// every participant shares, so slicing the raw string would show identical initials for all of
// them).
function idDigits(participantId: string): string {
  return participantId.split("@")[0];
}

// The operator's session carries the literal participantId "operator" (see mintSessionCookie
// call sites) — without this, their own messages render as "참가자 ...ator" (the last 4 chars
// of the string "operator"), which reads as a broken/anonymous reply instead of the operator's.
export function displayName(participantId: string, locale: "ko" | "en" = "ko"): string {
  if (participantId === "operator") return locale === "en" ? "Operator" : "운영자";
  const digits = idDigits(participantId).slice(-4);
  return locale === "en" ? `Participant ...${digits}` : `참가자 ...${digits}`;
}

export function avatarInitials(participantId: string, locale: "ko" | "en" = "ko"): string {
  if (participantId === "operator") return locale === "en" ? "OP" : "운영";
  return idDigits(participantId).slice(-2);
}
