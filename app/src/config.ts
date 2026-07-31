// All deploy-time knobs live here, read from env vars set by the CDK stack (§10) — nothing
// below is a fallback that hides a missing deploy parameter in production; SESSION_SECRET and
// PARTICIPANT_PASSPHRASE do have dev defaults so `docker compose up` works with no .env file.

export const config = {
  // Same secret the credentials-provider Lambda uses to derive Cognito IDs/passwords (§5.1) —
  // reusing it here lets the operator console re-derive any participant's ID and mint their
  // join link on demand, with no separate roster to keep in sync.
  sessionSecret: process.env.SESSION_SECRET ?? "dev-secret-do-not-use-in-production",
  participantPassphrase: process.env.PARTICIPANT_PASSPHRASE ?? "dev-passphrase",
  operatorPasscode: process.env.OPERATOR_PASSCODE ?? "dev-operator",
  scale: (process.env.SCALE as "small" | "large") ?? "small",
  participantCount: Number(process.env.PARTICIPANT_COUNT ?? 10),
  port: Number(process.env.PORT ?? 3000),
  sessionTtlSeconds: 60 * 60 * 24 * 4, // 4 days, comfortably covers the 3-day workshop
};
