import { config } from "../config.js";

const RESERVED_NAMES = new Set(["admin", "administrator", "operator", "\uc6b4\uc601\uc790", "\uad00\ub9ac\uc790"]);

export function parseNickname(value: unknown): { nickname: string } | { error: string } {
  if (typeof value !== "string") return { error: "nickname must be between 1 and 20 characters" };
  // Normalize compatibility characters before checking reserved operator names.
  const normalized = value.normalize("NFKC");
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalized)) return { error: "nickname contains unsupported characters" };
  const nickname = normalized.trim();
  if ([...nickname].length < 1 || [...nickname].length > 20) {
    return { error: "nickname must be between 1 and 20 characters" };
  }
  const lower = nickname.toLowerCase();
  if (RESERVED_NAMES.has(lower) || lower === config.adminUsername.normalize("NFKC").toLowerCase()) {
    return { error: "nickname is reserved" };
  }
  return { nickname };
}
