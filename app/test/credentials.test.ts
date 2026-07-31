import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveParticipantId, derivePassword, provisionCredentials } from "../src/auth/credentials.js";

const SEED = "test-deploy-seed";

test("derivation is deterministic", () => {
  assert.equal(deriveParticipantId(SEED, 0), deriveParticipantId(SEED, 0));
  assert.equal(derivePassword(SEED, 0), derivePassword(SEED, 0));
});

test("derived IDs are 12 numeric digits", () => {
  for (let i = 0; i < 20; i++) {
    const id = deriveParticipantId(SEED, i);
    assert.match(id, /^\d{12}$/);
  }
});

test("derived passwords satisfy Cognito's default policy (10+ chars, mixed classes)", () => {
  for (let i = 0; i < 20; i++) {
    const pw = derivePassword(SEED, i);
    assert.ok(pw.length >= 10);
    assert.match(pw, /[A-Z]/);
    assert.match(pw, /[a-z]/);
    assert.match(pw, /[0-9]/);
    assert.match(pw, /[!@#$%^&*]/);
  }
});

test("different indices derive different IDs (no collisions in a small sample)", () => {
  const ids = new Set(Array.from({ length: 50 }, (_, i) => deriveParticipantId(SEED, i)));
  assert.equal(ids.size, 50);
});

// The idempotency property this exists to prove: re-running provisioning after raising N
// creates only the missing delta — never duplicates, never re-creates existing users.

test("first run at N=10 creates exactly 10", async () => {
  const existing = new Set<string>();
  const createCalls: string[] = [];
  const result = await provisionCredentials({
    seed: SEED,
    count: 10,
    userExists: async (id) => existing.has(id),
    createUser: async (id) => {
      createCalls.push(id);
      existing.add(id);
    },
  });
  assert.equal(result.created.length, 10);
  assert.equal(result.skipped.length, 0);
  assert.equal(createCalls.length, 10);
});

test("re-running at the same N creates nothing new", async () => {
  const existing = new Set<string>();
  const createCalls: string[] = [];
  const createUser = async (id: string) => {
    createCalls.push(id);
    existing.add(id);
  };
  const userExists = async (id: string) => existing.has(id);

  await provisionCredentials({ seed: SEED, count: 10, userExists, createUser });
  createCalls.length = 0; // reset call log, keep `existing` state

  const second = await provisionCredentials({ seed: SEED, count: 10, userExists, createUser });
  assert.equal(second.created.length, 0);
  assert.equal(second.skipped.length, 10);
  assert.equal(createCalls.length, 0, "no duplicate AdminCreateUser calls on a re-run");
});

test("raising N from 10 to 12 creates exactly the 2 new participants, never touching the first 10", async () => {
  const existing = new Set<string>();
  const createCalls: string[] = [];
  const createUser = async (id: string) => {
    createCalls.push(id);
    existing.add(id);
  };
  const userExists = async (id: string) => existing.has(id);

  await provisionCredentials({ seed: SEED, count: 10, userExists, createUser });
  const originalTen = new Set(existing);
  createCalls.length = 0;

  const grown = await provisionCredentials({ seed: SEED, count: 12, userExists, createUser });
  assert.equal(grown.created.length, 2);
  assert.equal(grown.skipped.length, 10);
  assert.equal(existing.size, 12);
  for (const id of originalTen) assert.ok(existing.has(id), "original participants must be untouched");
});
