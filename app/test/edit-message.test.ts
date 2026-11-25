import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { authRoutes } from "../src/routes/auth.js";
import { chatRoutes } from "../src/routes/chat.js";
import { config } from "../src/config.js";
import { mockDatabase } from "./helpers/database.js";

async function setup(t: TestContext) {
  const previous = (config as any).participantAuthMode;
  (config as any).participantAuthMode = "nickname";
  t.after(() => { (config as any).participantAuthMode = previous; });
  const items = mockDatabase(t);
  const app = Fastify();
  await app.register(fastifyCookie);
  await app.register(authRoutes);
  await app.register(chatRoutes);
  t.after(() => app.close());

  async function join(nickname: string) {
    const res = await app.inject({ method: "POST", url: "/api/login/nickname", payload: { nickname } });
    const cookie = res.cookies.find((c) => c.name === "wc_session");
    assert.ok(cookie);
    return { wc_session: cookie.value };
  }
  async function post(cookies: Record<string, string>, payload: Record<string, unknown>) {
    const res = await app.inject({ method: "POST", url: "/api/channels/general/messages", cookies, payload });
    assert.equal(res.statusCode, 200);
    return res.json().message as { sk: string; pk: string };
  }
  function edit(cookies: Record<string, string> | undefined, ulid: string, payload: Record<string, unknown>) {
    return app.inject({ method: "PATCH", url: `/api/channels/general/messages/${ulid}`, cookies, payload });
  }
  return { app, items, join, post, edit };
}

const ulidOf = (m: { sk: string }) => m.sk.replace("MSG#", "");

test("the author can edit a channel message and the change is stored with editedAt", async (t) => {
  const { app, items, join, post, edit } = await setup(t);
  const author = await join("author");
  const message = await post(author, { body: "first draft", kind: "question" });

  const res = await edit(author, ulidOf(message), { body: "second draft" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().message.body, "second draft");
  assert.match(res.json().message.editedAt, /^\d{4}-\d{2}-\d{2}T/);

  const stored = items.get(`${message.pk}|${message.sk}`);
  assert.equal(stored?.body, "second draft");
  assert.equal(stored?.kind, "question");
  assert.equal(stored?.upvotes, 0);

  const listed = (await app.inject({ url: "/api/channels/general/messages", cookies: author })).json().messages;
  assert.equal(listed[0].body, "second draft");
});

test("only the author can edit, and only while signed in", async (t) => {
  const { items, join, post, edit } = await setup(t);
  const author = await join("author");
  const other = await join("other");
  const message = await post(author, { body: "mine" });

  assert.equal((await edit(other, ulidOf(message), { body: "hijacked" })).statusCode, 403);
  assert.equal((await edit(undefined, ulidOf(message), { body: "anonymous" })).statusCode, 401);
  assert.equal(items.get(`${message.pk}|${message.sk}`)?.body, "mine");
});

test("edit rejects an empty or oversized body", async (t) => {
  const { items, join, post, edit } = await setup(t);
  const author = await join("author");
  const message = await post(author, { body: "keep me" });

  assert.equal((await edit(author, ulidOf(message), { body: "   " })).statusCode, 400);
  assert.equal((await edit(author, ulidOf(message), {})).statusCode, 400);
  assert.equal((await edit(author, ulidOf(message), { body: "x".repeat(4001) })).statusCode, 400);
  assert.equal(items.get(`${message.pk}|${message.sk}`)?.body, "keep me");
});

test("edit returns 404 for a missing or deleted message and never creates one", async (t) => {
  const { items, join, post, edit } = await setup(t);
  const author = await join("author");

  assert.equal((await edit(author, "01HZZZZZZZZZZZZZZZZZZZZZZZ", { body: "ghost" })).statusCode, 404);
  assert.equal(items.has("CHANNEL#general|MSG#01HZZZZZZZZZZZZZZZZZZZZZZZ"), false);

  const message = await post(author, { body: "soon gone" });
  items.get(`${message.pk}|${message.sk}`)!.deleted = true;
  assert.equal((await edit(author, ulidOf(message), { body: "revived" })).statusCode, 404);
  assert.equal(items.get(`${message.pk}|${message.sk}`)?.body, "soon gone");
});

test("the author can edit a thread reply, addressed by its root", async (t) => {
  const { items, join, post, edit } = await setup(t);
  const author = await join("author");
  const other = await join("other");
  const root = await post(other, { body: "root" });
  const reply = await post(author, { body: "reply v1", threadId: ulidOf(root) });
  assert.equal(reply.pk, `THREAD#${ulidOf(root)}`);

  // Without threadId the reply is not found under the channel partition.
  assert.equal((await edit(author, ulidOf(reply), { body: "reply v2" })).statusCode, 404);
  assert.equal((await edit(other, ulidOf(reply), { body: "nope", threadId: ulidOf(root) })).statusCode, 403);

  const res = await edit(author, ulidOf(reply), { body: "reply v2", threadId: ulidOf(root) });
  assert.equal(res.statusCode, 200);
  assert.equal(items.get(`${reply.pk}|${reply.sk}`)?.body, "reply v2");
  assert.equal(items.get(`${root.pk}|${root.sk}`)?.body, "root");
});

test("a blocked participant cannot edit", async (t) => {
  const { items, join, post, edit } = await setup(t);
  const author = await join("author");
  const message = await post(author, { body: "before block" });
  const participant = [...items.values()].find((i) => i.pk.startsWith("USER#") && i.displayName === "author");
  participant!.blocked = true;

  assert.equal((await edit(author, ulidOf(message), { body: "after block" })).statusCode, 403);
});
