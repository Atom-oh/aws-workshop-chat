// Deterministic per-participant avatar color — same idea as Slack's generated-color avatars.
export function avatarColor(id: string): string {
  if (id === "operator") return "#DD344C";
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash}, 55%, 42%)`;
}

// The operator's session carries the literal participantId "operator" (see mintSessionCookie
// call sites) — without this, their own messages render as "참가자 ...ator" (the last 4 chars
// of the string "operator"), which reads as a broken/anonymous reply instead of the operator's.
export function displayName(participantId: string): string {
  return participantId === "operator" ? "운영자" : `참가자 ...${participantId.slice(-4)}`;
}

export function avatarInitials(participantId: string): string {
  return participantId === "operator" ? "운영" : participantId.slice(-2);
}
