import { test } from "node:test";
import assert from "node:assert/strict";
import { participantIdOf } from "../src/auth/cognito.js";
import { resolveRosterWith } from "../src/routes/operator.js";

// Pools with UsernameAttributes: [email] (the hand-written CFN template some deployments run)
// hand back an opaque generated Username; the real, login-usable ID lives in the email
// attribute. Pools with signInAliases: { username: true } (this repo's own CDK stack) have the
// ID as Username directly. Which one applies is decided from the pool's own config, not
// guessed per-user from attribute presence — a stray/shared email attribute on a
// username-is-the-id pool must never get misread as (or collide on) the real ID.
test("participantIdOf reads from Username when the pool's UsernameAttributes isn't email", () => {
  assert.equal(participantIdOf("084823346972@ws", undefined, false), "084823346972@ws");
  assert.equal(participantIdOf("084823346972@ws", [{ Name: "email", Value: "someone-elses-id@ws" }], false), "084823346972@ws");
});

test("participantIdOf reads from the email attribute when the pool's UsernameAttributes is email", () => {
  assert.equal(
    participantIdOf("c4681dec-b011-7023-524b-a7658a6db468", [{ Name: "email", Value: "255427815287@ws" }], true),
    "255427815287@ws",
  );
});

test("participantIdOf throws rather than silently miss an ID when UsernameAttributes is email but the attribute is absent", () => {
  assert.throws(() => participantIdOf("c4681dec-...", undefined, true));
});

// resolveRosterWith is the fallback switch behind the operator console's roster/attendance
// views: Cognito is the source of truth whenever it's configured, and the derived roster only
// exists for local dev with no user pool at all.
test("resolveRosterWith uses the Cognito roster when one comes back", async () => {
  const result = await resolveRosterWith(async () => ["255427815287@ws"], ["000000000000@ws"]);
  assert.deepEqual(result, { ids: ["255427815287@ws"], source: "cognito" });
});

test("resolveRosterWith falls back to the derived roster when Cognito isn't configured", async () => {
  const result = await resolveRosterWith(async () => null, ["000000000000@ws", "111111111111@ws"]);
  assert.deepEqual(result, { ids: ["000000000000@ws", "111111111111@ws"], source: "derived" });
});

test("resolveRosterWith propagates a real lookup failure instead of masking it as an empty roster", async () => {
  await assert.rejects(
    () => resolveRosterWith(async () => { throw new Error("AccessDeniedException"); }, []),
    /AccessDeniedException/,
  );
});
