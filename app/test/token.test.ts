import { test } from "node:test";
import assert from "node:assert/strict";
import { issueToken, verifyToken } from "../src/auth/token.js";

const SECRET = "test-secret";
const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 1;

test("valid token round-trips", () => {
  const token = issueToken({ participantId: "123456789012", role: "participant", exp: future }, SECRET);
  const payload = verifyToken(token, SECRET);
  assert.ok(payload);
  assert.equal(payload!.participantId, "123456789012");
  assert.equal(payload!.role, "participant");
});

test("tampered payload is rejected", () => {
  const token = issueToken({ participantId: "123456789012", role: "participant", exp: future }, SECRET);
  const [body, sig] = token.split(".");
  const tamperedBody = Buffer.from(JSON.stringify({ participantId: "999999999999", role: "operator", exp: future })).toString(
    "base64url",
  );
  assert.equal(verifyToken(`${tamperedBody}.${sig}`, SECRET), null);
});

test("truncated token is rejected", () => {
  const token = issueToken({ participantId: "123456789012", role: "participant", exp: future }, SECRET);
  assert.equal(verifyToken(token.slice(0, -4), SECRET), null);
});

test("wrong signature is rejected", () => {
  const token = issueToken({ participantId: "123456789012", role: "participant", exp: future }, SECRET);
  assert.equal(verifyToken(token, "different-secret"), null);
});

test("expired token is rejected", () => {
  const token = issueToken({ participantId: "123456789012", role: "participant", exp: past }, SECRET);
  assert.equal(verifyToken(token, SECRET), null);
});

test("malformed token (no dot) is rejected", () => {
  assert.equal(verifyToken("not-a-real-token", SECRET), null);
});
