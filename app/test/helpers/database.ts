import type { TestContext } from "node:test";
import { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client.js";

// Replace only the external DynamoDB boundary; routes, repository code and cookies stay real.
export function mockDatabase(t: TestContext) {
  const items = new Map<string, Record<string, any>>();
  const keyOf = (item: Record<string, any>) => `${item.pk}|${item.sk}`;
  t.mock.method(ddb, "send", async (command: any) => {
    const input = command.input;
    if (command instanceof GetCommand) return { Item: structuredClone(items.get(keyOf(input.Key))) };
    if (command instanceof PutCommand) {
      items.set(keyOf(input.Item), structuredClone(input.Item));
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      const writes = command.input.TransactItems?.map((item) => {
        if (!item.Put?.Item) throw new Error("Unexpected transaction operation");
        return item.Put.Item;
      }) ?? [];
      for (const item of writes) items.set(keyOf(item), structuredClone(item));
      return {};
    }
    if (command instanceof ScanCommand) {
      return { Items: [...items.values()].filter((i) => i.pk.startsWith("USER#") && i.sk === "META") };
    }
    if (command instanceof QueryCommand) {
      const values = input.ExpressionAttributeValues;
      return { Items: [...items.values()].filter((i) =>
        i.pk === values[":pk"] && (!values[":prefix"] || i.sk.startsWith(values[":prefix"]))) };
    }
    if (command instanceof UpdateCommand) {
      const item = items.get(keyOf(input.Key)) ?? { ...input.Key };
      if (input.UpdateExpression.includes("replyCount")) item.replyCount = (item.replyCount ?? 0) + 1;
      items.set(keyOf(item), item);
      return { Attributes: structuredClone(item) };
    }
    throw new Error(`Unexpected database operation: ${command.constructor.name}`);
  });
  return items;
}
