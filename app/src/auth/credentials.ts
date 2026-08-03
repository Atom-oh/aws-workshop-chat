// Deterministic, idempotent credential generation for participants.
//
// "Idempotent" here means: given the same (seed, index), the derived participantId is always
// the same, so provisioning can be re-run safely — raising participantCount from 100 to 120
// creates exactly the missing 20 rather than re-creating (or duplicating) the first 100. This
// is also the late-joiner path from §5.2/5.3: the same provisioning call, re-run, picks up
// anyone new.

import { createHmac } from "node:crypto";

const SYMBOLS = "!@#$%^&*";

function hmacHex(seed: string, label: string): string {
  return createHmac("sha256", seed).update(label).digest("hex");
}

/**
 * "<12-digit AWS-account-ID-shaped number>@ws" — the `@ws` suffix matches the operator
 * account's own username convention (`admin@ws`) so every login, Cognito username, and
 * roster row uses the same shape regardless of role.
 */
export function deriveParticipantId(seed: string, index: number): string {
  const hex = hmacHex(seed, `id:${index}`);
  // take enough hex chars to safely derive 12 decimal digits without modulo bias at this range
  const n = BigInt(`0x${hex.slice(0, 16)}`);
  const digits = (n % 1_000_000_000_000n).toString().padStart(12, "0");
  return `${digits}@ws`;
}

/** 10+ char password satisfying Cognito's default policy: upper, lower, digit, symbol. */
export function derivePassword(seed: string, index: number): string {
  const hex = hmacHex(seed, `pw:${index}`);
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no ambiguous chars for anyone reading it aloud
  const lower = upper.toLowerCase();
  const digits = "23456789";
  const pick = (alphabet: string, byte: number) => alphabet[byte % alphabet.length];

  const bytes = Buffer.from(hex, "hex");
  const chars = [
    pick(upper, bytes[0]),
    pick(lower, bytes[1]),
    pick(digits, bytes[2]),
    pick(SYMBOLS, bytes[3]),
  ];
  for (let i = 4; i < 12; i++) {
    chars.push(pick(upper + lower + digits, bytes[i % bytes.length] ^ i));
  }
  return chars.join("");
}

export interface ProvisionResult {
  created: string[];
  skipped: string[];
}

/**
 * Ensures exactly `count` participant credentials exist. Callback-injected so this is testable
 * without a real Cognito user pool: `userExists` and `createUser` stand in for
 * AdminGetUser / AdminCreateUser + AdminSetUserPassword.
 */
export async function provisionCredentials(opts: {
  seed: string;
  count: number;
  userExists: (participantId: string) => Promise<boolean>;
  createUser: (participantId: string, password: string) => Promise<void>;
}): Promise<ProvisionResult> {
  const created: string[] = [];
  const skipped: string[] = [];

  for (let i = 0; i < opts.count; i++) {
    const participantId = deriveParticipantId(opts.seed, i);
    if (await opts.userExists(participantId)) {
      skipped.push(participantId);
      continue;
    }
    const password = derivePassword(opts.seed, i);
    await opts.createUser(participantId, password);
    created.push(participantId);
  }
  return { created, skipped };
}
