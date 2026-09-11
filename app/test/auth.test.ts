import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { authRoutes } from "../src/routes/auth.js";
import { chatRoutes } from "../src/routes/chat.js";
import { operatorRoutes } from "../src/routes/operator.js";
import { config } from "../src/config.js";
import { issueToken } from "../src/auth/token.js";
import { mockDatabase } from "./helpers/database.js";
import { ddb } from "../src/db/client.js";
import { fetchExportData } from "../src/export/xlsx.js";

async function setup(t: TestContext, mode = "nickname") {
  const previous = (config as any).participantAuthMode;
  (config as any).participantAuthMode = mode;
  t.after(() => { (config as any).participantAuthMode = previous; });
  const items = mockDatabase(t);
  t.mock.method(CognitoIdentityProviderClient.prototype, "send", async () => {
    throw new Error("Nickname entry must not call Cognito");
  });
  const app = Fastify();
  await app.register(fastifyCookie);
  await app.register(authRoutes);
  await app.register(chatRoutes);
  await app.register(operatorRoutes);
  t.after(() => app.close());
  return { app, items };
}

function cookieOf(response: { cookies: { name: string; value: string }[] }) {
  const cookie = response.cookies.find((c) => c.name === "wc_session");
  assert.ok(cookie, "successful entry must issue a session cookie");
  return { wc_session: cookie.value };
}

test("session discovery exposes the deployment mode before login", async (t) => {
  const { app } = await setup(t);
  const response = await app.inject("/api/session");
  assert.deepEqual(response.json(), { session: null, participantAuthMode: "nickname" });
  assert.match(String(response.headers["cache-control"]), /no-store/);
});

test("nickname entry persists its name and restores the participant on reload", async (t) => {
  const { app, items } = await setup(t);
  const response = await app.inject({
    method: "POST", url: "/api/login/nickname",
    payload: { nickname: "  \ud558\ub298  ", participantId: "operator", role: "operator" },
  });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["set-cookie"]), /HttpOnly/i);
  const cookies = cookieOf(response);
  const session = (await app.inject({ url: "/api/session", cookies })).json().session;
  assert.equal(session.role, "participant");
  assert.equal(session.authMode, "nickname");
  assert.equal(session.displayName, "\ud558\ub298");
  assert.match(session.participantId, /^guest-[a-f0-9-]{36}$/);
  const participant = items.get(`USER#${session.participantId}|META`);
  assert.equal(participant?.displayName, "\ud558\ub298");
  assert.equal(participant?.authMode, "nickname");
  const exported = await fetchExportData();
  assert.equal(exported.participants[0].displayName, "\ud558\ub298");
  assert.equal([...items.values()].filter((i) => i.event === "login").length, 1);
  assert.equal((await app.inject({ url: "/api/operator/roster", cookies })).statusCode, 403);

  const repeated = await app.inject({
    method: "POST", url: "/api/login/nickname", cookies, payload: { nickname: "Another name" },
  });
  assert.equal(repeated.statusCode, 200);
  const same = (await app.inject({ url: "/api/session", cookies: cookieOf(repeated) })).json().session;
  assert.equal(same.participantId, session.participantId);
  assert.equal(same.displayName, "\ud558\ub298");
  assert.equal([...items.values()].filter((i) => i.authMode === "nickname").length, 1);
});

test("the same nickname in a new browser never takes over another participant", async (t) => {
  const { app } = await setup(t);
  const sessions = [];
  for (let i = 0; i < 2; i++) {
    const joined = await app.inject({ method: "POST", url: "/api/login/nickname", payload: { nickname: "Alex" } });
    assert.equal(joined.statusCode, 200);
    sessions.push((await app.inject({ url: "/api/session", cookies: cookieOf(joined) })).json().session);
  }
  assert.notEqual(sessions[0].participantId, sessions[1].participantId);
});

test("retrying entry preserves identity even when an eventual read cannot see the new participant", async (t) => {
  const { app } = await setup(t);
  const joined = await app.inject({ method: "POST", url: "/api/login/nickname", payload: { nickname: "Alex" } });
  const cookies = cookieOf(joined);
  const original = (await app.inject({ url: "/api/session", cookies })).json().session;
  const send = ddb.send.bind(ddb);
  t.mock.method(ddb, "send", async (command: any) => {
    if (command instanceof GetCommand && command.input.Key?.pk === `USER#${original.participantId}` && !command.input.ConsistentRead) {
      return {};
    }
    return send(command);
  });
  const repeated = await app.inject({
    method: "POST", url: "/api/login/nickname", cookies, payload: { nickname: "Alex" },
  });
  const restored = (await app.inject({ url: "/api/session", cookies: cookieOf(repeated) })).json().session;
  assert.equal(restored.participantId, original.participantId);
});

for (const failure of ["lab-step", "login-event"]) {
  test(`failed ${failure} storage leaves no ghost participant and entry can be retried`, async (t) => {
    const { app, items } = await setup(t);
    const send = ddb.send.bind(ddb);
    let fail = true;
    t.mock.method(ddb, "send", async (command: any) => {
      const readsLabStep = command instanceof GetCommand && command.input.Key?.sk === "LABSTEP";
      const writesLogin = (command instanceof PutCommand && command.input.Item?.event === "login")
        || (command instanceof TransactWriteCommand && command.input.TransactItems?.some((i) => i.Put?.Item?.event === "login"));
      if (fail && (failure === "lab-step" ? readsLabStep : writesLogin)) throw new Error("Simulated storage failure");
      return send(command);
    });
    const response = await app.inject({ method: "POST", url: "/api/login/nickname", payload: { nickname: "Alex" } });
    assert.equal(response.statusCode, 500);
    assert.equal(response.cookies.length, 0);
    assert.equal([...items.values()].filter((i) => i.authMode === "nickname").length, 0);
    fail = false;
    const retry = await app.inject({ method: "POST", url: "/api/login/nickname", payload: { nickname: "Alex" } });
    assert.equal(retry.statusCode, 200);
    assert.equal([...items.values()].filter((i) => i.authMode === "nickname").length, 1);
    assert.equal([...items.values()].filter((i) => i.event === "login").length, 1);
  });
}

test("malformed and misleading nicknames are rejected before creating any records", async (t) => {
  const { app, items } = await setup(t);
  const invalid = [
    {}, { nickname: null }, { nickname: 123 }, { nickname: [] },
    { nickname: "" }, { nickname: "  " }, { nickname: "a".repeat(21) },
    { nickname: "A\nB" }, { nickname: "A\u202eB" }, { nickname: "\ud800" },
    { nickname: "operator" }, { nickname: "ADMIN" }, { nickname: "\uff41\uff44\uff4d\uff49\uff4e" },
    { nickname: "\uc6b4\uc601\uc790" }, { nickname: config.adminUsername },
  ];
  for (const payload of invalid) {
    const response = await app.inject({ method: "POST", url: "/api/login/nickname", payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.cookies.length, 0);
  }
  assert.equal(items.size, 0);
});

test("nickname length counts Unicode characters and accepts the exact limit", async (t) => {
  const { app } = await setup(t);
  const nickname = "\ud83d\ude80".repeat(20);
  const response = await app.inject({ method: "POST", url: "/api/login/nickname", payload: { nickname } });
  assert.equal(response.statusCode, 200);
  const session = (await app.inject({ url: "/api/session", cookies: cookieOf(response) })).json().session;
  assert.equal(session.displayName, nickname);
});

test("logout clears the guest cookie and re-entry starts a new identity", async (t) => {
  const { app } = await setup(t);
  const joined = await app.inject({ method: "POST", url: "/api/login/nickname", payload: { nickname: "Alex" } });
  assert.equal(joined.statusCode, 200);
  const cookies = cookieOf(joined);
  const before = (await app.inject({ url: "/api/session", cookies })).json().session;
  const loggedOut = await app.inject({ method: "POST", url: "/api/logout", cookies });
  assert.equal(loggedOut.statusCode, 200);
  assert.equal(loggedOut.cookies[0].value, "");
  assert.equal((await app.inject("/api/session")).json().session, null);
  const rejoined = await app.inject({ method: "POST", url: "/api/login/nickname", payload: { nickname: "Alex" } });
  const after = (await app.inject({ url: "/api/session", cookies: cookieOf(rejoined) })).json().session;
  assert.notEqual(before.participantId, after.participantId);
});

test("nickname entry is disabled in Cognito mode and old guest sessions cannot bypass it", async (t) => {
  const { app } = await setup(t);
  const joined = await app.inject({ method: "POST", url: "/api/login/nickname", payload: { nickname: "Alex" } });
  assert.equal(joined.statusCode, 200);
  const cookies = cookieOf(joined);
  (config as any).participantAuthMode = "cognito";
  const disabled = await app.inject({ method: "POST", url: "/api/login/nickname", payload: { nickname: "Alex" } });
  assert.equal(disabled.statusCode, 403);
  assert.equal((await app.inject({ url: "/api/session", cookies })).json().session, null);
  assert.equal((await app.inject({ url: "/api/channels/chat/messages", cookies })).statusCode, 401);
});

test("Cognito mode preserves legacy signed participant links and operator sessions", async (t) => {
  const { app } = await setup(t, "cognito");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  for (const role of ["participant", "operator"] as const) {
    const participantId = role === "operator" ? "operator" : "123456789012@ws";
    const token = issueToken({ participantId, role, exp }, config.sessionSecret);
    const response = await app.inject(`/j?t=${encodeURIComponent(token)}`);
    assert.equal(response.statusCode, 302);
    const session = (await app.inject({ url: "/api/session", cookies: cookieOf(response) })).json().session;
    assert.equal(session.participantId, participantId);
    assert.equal(session.role, role);
  }
});

test("nickname mode keeps operator links usable and redirects legacy participant links to entry", async (t) => {
  const { app } = await setup(t);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const participant = issueToken({ participantId: "123456789012@ws", role: "participant", exp }, config.sessionSecret);
  const redirect = await app.inject(`/j?t=${encodeURIComponent(participant)}`);
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.cookies.length, 0);
  const operator = issueToken({ participantId: "operator", role: "operator", exp }, config.sessionSecret);
  const response = await app.inject(`/j?t=${encodeURIComponent(operator)}`);
  assert.equal(response.statusCode, 302);
  assert.equal((await app.inject({ url: "/api/session", cookies: cookieOf(response) })).json().session.role, "operator");
});

test("messages and replies use the saved nickname instead of caller-supplied names", async (t) => {
  const { app } = await setup(t);
  const joined = await app.inject({ method: "POST", url: "/api/login/nickname", payload: { nickname: "Alex" } });
  assert.equal(joined.statusCode, 200);
  const cookies = cookieOf(joined);
  const posted = await app.inject({
    method: "POST", url: "/api/channels/chat/messages", cookies,
    payload: { body: "Hello", displayName: "operator" },
  });
  assert.equal(posted.statusCode, 200);
  assert.equal(posted.json().message.displayName, "Alex");
  const messages = (await app.inject({ url: "/api/channels/chat/messages", cookies })).json().messages;
  assert.equal(messages[0].displayName, "Alex");
  const threadId = posted.json().message.sk.slice(4);
  const reply = await app.inject({
    method: "POST", url: "/api/channels/chat/messages", cookies,
    payload: { body: "Reply", threadId, displayName: "operator" },
  });
  assert.equal(reply.statusCode, 200);
  const replies = (await app.inject({ url: `/api/threads/${threadId}`, cookies })).json().replies;
  assert.equal(replies[0].displayName, "Alex");
});

test("nickname roster lists actual guests and distributes a shared link without impersonation tokens", async (t) => {
  const { app, items } = await setup(t);
  const joined = await app.inject({ method: "POST", url: "/api/login/nickname", payload: { nickname: "Alex" } });
  assert.equal(joined.statusCode, 200);
  items.set("USER#old@ws|META", { pk: "USER#old@ws", sk: "META", participantId: "old@ws", displayName: "old" });
  const operator = issueToken({
    participantId: "operator", role: "operator", exp: Math.floor(Date.now() / 1000) + 3600,
  }, config.sessionSecret);
  const cookies = { wc_session: operator };
  const roster = (await app.inject({ url: "/api/operator/roster", cookies })).json();
  assert.equal(roster.source, "nickname");
  assert.equal(roster.roster.length, 1);
  assert.equal(roster.roster[0].displayName, "Alex");
  assert.equal(roster.joinUrl, "http://localhost:80/");
  assert.equal(roster.roster[0].joinUrl, roster.joinUrl);
  const attendance = (await app.inject({ url: "/api/operator/attendance", cookies })).json();
  assert.equal(attendance.source, "nickname");
  assert.equal(attendance.joinedCount, 1);
  assert.equal(attendance.expectedCount, config.participantCount);
  assert.equal(attendance.noShowCount, config.participantCount - 1);
  assert.deepEqual(attendance.noShows, []);
});

test("a blocked guest cannot reset their existing session through nickname entry", async (t) => {
  const { app, items } = await setup(t);
  const joined = await app.inject({ method: "POST", url: "/api/login/nickname", payload: { nickname: "Alex" } });
  assert.equal(joined.statusCode, 200);
  const cookies = cookieOf(joined);
  const session = (await app.inject({ url: "/api/session", cookies })).json().session;
  items.get(`USER#${session.participantId}|META`)!.blocked = true;
  const response = await app.inject({ method: "POST", url: "/api/login/nickname", cookies, payload: { nickname: "New name" } });
  assert.equal(response.statusCode, 403);
  assert.equal([...items.values()].filter((i) => i.authMode === "nickname").length, 1);
  const message = await app.inject({ method: "POST", url: "/api/channels/chat/messages", cookies, payload: { body: "Hi" } });
  assert.equal(message.statusCode, 403);
});
