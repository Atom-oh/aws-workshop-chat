import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ddb } from "../src/db/client.js";
import { listMessages, listTimeline, listParticipants, listQuestionsByStatus } from "../src/db/repo.js";

// DynamoDB caps a single Query/Scan response at 1MB regardless of how many items actually match
// — without paging through LastEvaluatedKey, a channel/workshop with enough history silently
// loses everything past that boundary. These tests mock ddb.send to return exactly two pages,
// the smallest case that would previously have dropped page 2 on the floor.

function twoPageQuery(page1: unknown[], page2: unknown[]) {
  let call = 0;
  return mock.fn(async () => {
    call++;
    return call === 1
      ? { Items: page1, LastEvaluatedKey: { pk: "cursor" } }
      : { Items: page2, LastEvaluatedKey: undefined };
  });
}

test("listMessages (export mode, no limit) follows LastEvaluatedKey across pages", async (t) => {
  const page1 = [{ pk: "CHANNEL#questions", sk: "MSG#a" }];
  const page2 = [{ pk: "CHANNEL#questions", sk: "MSG#b" }];
  t.mock.method(ddb, "send", twoPageQuery(page1, page2));

  const all = await listMessages("questions");
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((m: any) => m.sk), ["MSG#a", "MSG#b"]);
  assert.equal((ddb.send as ReturnType<typeof mock.fn>).mock.callCount(), 2);
});

test("listMessages (screen mode, with limit) takes only the first page — by design", async (t) => {
  const page1 = [{ pk: "CHANNEL#questions", sk: "MSG#a" }];
  const page2 = [{ pk: "CHANNEL#questions", sk: "MSG#b" }];
  t.mock.method(ddb, "send", twoPageQuery(page1, page2));

  const first100 = await listMessages("questions", { limit: 100 });
  assert.equal(first100.length, 1);
  assert.equal((ddb.send as ReturnType<typeof mock.fn>).mock.callCount(), 1);
});

test("listTimeline pages through the whole WORKSHOP partition", async (t) => {
  const page1 = [{ pk: "WORKSHOP", sk: "EVT#1" }];
  const page2 = [{ pk: "WORKSHOP", sk: "EVT#2" }];
  t.mock.method(ddb, "send", twoPageQuery(page1, page2));

  const all = await listTimeline();
  assert.equal(all.length, 2);
});

test("listParticipants (Scan) pages through the whole table", async (t) => {
  const page1 = [{ pk: "USER#1", sk: "META" }];
  const page2 = [{ pk: "USER#2", sk: "META" }];
  t.mock.method(ddb, "send", twoPageQuery(page1, page2));

  const all = await listParticipants();
  assert.equal(all.length, 2);
});

test("listQuestionsByStatus pages through the whole QSTATUS partition", async (t) => {
  const page1 = [{ pk: "QSTATUS#open", sk: "0001#a", messageId: "a" }];
  const page2 = [{ pk: "QSTATUS#open", sk: "0002#b", messageId: "b" }];
  t.mock.method(ddb, "send", twoPageQuery(page1, page2));

  const all = await listQuestionsByStatus("open");
  assert.equal(all.length, 2);
});
