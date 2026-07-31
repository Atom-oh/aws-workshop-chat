import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// ponytail: one shared client for the process; a Lambda-per-request model would need one per
// invocation, but this app is a single long-running Fargate task.
const raw = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT, // set for docker-compose / DynamoDB Local
  region: process.env.AWS_REGION ?? "us-east-1",
});

export const ddb = DynamoDBDocumentClient.from(raw, {
  marshallOptions: { removeUndefinedValues: true },
});
