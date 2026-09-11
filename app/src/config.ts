// All deploy-time knobs live here, read from env vars set by the CDK stack (§10) — nothing
// below is a fallback that hides a missing deploy parameter in production; SESSION_SECRET and
// PARTICIPANT_PASSPHRASE do have dev defaults so `docker compose up` works with no .env file.

export type ParticipantAuthMode = "cognito" | "nickname";

function participantAuthMode(): ParticipantAuthMode {
  const value = process.env.PARTICIPANT_AUTH_MODE ?? "cognito";
  if (value !== "cognito" && value !== "nickname") {
    throw new Error("PARTICIPANT_AUTH_MODE must be cognito or nickname");
  }
  return value;
}

export const config = {
  participantAuthMode: participantAuthMode(),
  // Same secret the credentials-provider Lambda uses to derive Cognito IDs/passwords (§5.1) —
  // reusing it here lets the operator console re-derive any participant's ID and mint their
  // join link on demand, with no separate roster to keep in sync.
  sessionSecret: process.env.SESSION_SECRET ?? "dev-secret-do-not-use-in-production",
  participantPassphrase: process.env.PARTICIPANT_PASSPHRASE ?? "dev-passphrase",
  // The one operator account, provisioned in Cognito at deploy time (infra/lib/workshop-chat-stack.ts)
  // with a random password. Role for any Cognito login (/api/login/id) comes from group
  // membership, not from comparing the typed username against this value.
  adminUsername: process.env.ADMIN_USERNAME ?? "admin@ws",
  scale: (process.env.SCALE as "small" | "large") ?? "small",
  // In nickname mode this is the anticipated headcount, not an admission limit.
  // In Cognito mode it is only meaningful for the local-dev fallback roster
  // (see resolveRoster in routes/operator.ts) — once COGNITO_USER_POOL_ID is set, the
  // `participant` group in Cognito is the real headcount and this value is never read for it.
  participantCount: Number(process.env.PARTICIPANT_COUNT ?? 10),
  port: Number(process.env.PORT ?? 3000),
  sessionTtlSeconds: 60 * 60 * 24 * 4, // 4 days, comfortably covers the 3-day workshop
};
