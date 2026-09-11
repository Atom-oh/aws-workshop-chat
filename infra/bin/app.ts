#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { WorkshopChatStack } from "../lib/workshop-chat-stack";
import { WorkshopChatWafStack } from "../lib/waf-stack";
import { WorkshopChatBedrockStack } from "../lib/bedrock-stack";

const app = new App();

// Explicit context takes precedence over the environment; validate before creating resources.
const contextParticipantAuthMode: unknown = app.node.tryGetContext("participantAuthMode");
const participantAuthMode =
  contextParticipantAuthMode === undefined
    ? process.env.PARTICIPANT_AUTH_MODE ?? "cognito"
    : contextParticipantAuthMode;
if (participantAuthMode !== "cognito" && participantAuthMode !== "nickname") {
  throw new Error(
    `Invalid participantAuthMode/PARTICIPANT_AUTH_MODE: ${String(participantAuthMode)}. Expected cognito or nickname.`,
  );
}

// Deploy-time knobs come from --context (participantAuthMode also accepts the environment).
// Region and account come from the CLI's resolved environment (CDK_DEFAULT_REGION/ACCOUNT)
// so the same template deploys anywhere a Central Account sits (see README.md).
const workshopName = app.node.tryGetContext("workshopName") ?? "aws-workshop-chat";
const scale = (app.node.tryGetContext("scale") ?? "small") as "small" | "large";
const bedrockModelId = app.node.tryGetContext("bedrockModelId");
const adminUsername = app.node.tryGetContext("adminUsername") ?? "admin@ws";
const participantPassphrase = app.node.tryGetContext("participantPassphrase");
const participantCount = Number(app.node.tryGetContext("participantCount") ?? 50);
const enableKnowledgeBase = (app.node.tryGetContext("enableKnowledgeBase") ?? "true") !== "false";
// Optional — all three together attach a custom domain to CloudFront; omit any to fall back
// to the raw CloudFront domain (the reusable-workshop default).
const domainName = app.node.tryGetContext("domainName");
const hostedZoneId = app.node.tryGetContext("hostedZoneId");
const hostedZoneName = app.node.tryGetContext("hostedZoneName");
const certificateArn = app.node.tryGetContext("certificateArn");
// Optional — some environments (e.g. an AWS Workshop Studio participant account) only expose
// Bedrock in one region (us-east-1) while the rest of the app deploys wherever's closest to
// participants. Defaults to the main stack's own region, so single-region deploys need this
// flag not at all.
const bedrockRegion = app.node.tryGetContext("bedrockRegion") ?? process.env.CDK_DEFAULT_REGION;

for (const [key, value] of Object.entries({ bedrockModelId, participantPassphrase })) {
  if (!value) {
    throw new Error(`Missing required --context ${key}=... (see README.md for the full deploy command)`);
  }
}

// CLOUDFRONT-scoped WAFv2 WebACLs are a us-east-1-only API regardless of the app stack's region
// (see lib/waf-stack.ts) — a separate stack + CDK's cross-region reference support is the
// smallest way to satisfy that without hardcoding the app's own deploy region to us-east-1.
const wafStack = new WorkshopChatWafStack(app, `${workshopName}-WorkshopChatWaf`, {
  workshopName,
  crossRegionReferences: true,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
});

const bedrockStack = enableKnowledgeBase
  ? new WorkshopChatBedrockStack(app, `${workshopName}-WorkshopChatBedrock`, {
      workshopName,
      crossRegionReferences: true,
      env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: bedrockRegion },
    })
  : undefined;

new WorkshopChatStack(app, `${workshopName}-WorkshopChat`, {
  workshopName,
  scale,
  bedrockModelId,
  bedrockRegion,
  adminUsername,
  participantPassphrase,
  participantCount,
  participantAuthMode,
  // A Bedrock Knowledge Base's S3 data source must live in the same region as the KB itself, so
  // when the KB is enabled the guide bucket is owned by bedrock-stack.ts (pinned to
  // bedrockRegion) instead of here — see the comment there. Undefined when the KB is disabled;
  // workshop-chat-stack.ts creates its own bucket locally in that case.
  guideBucketName: bedrockStack?.guideBucketName,
  guideBucketRegion: bedrockStack ? bedrockRegion : process.env.CDK_DEFAULT_REGION,
  knowledgeBaseId: bedrockStack?.knowledgeBaseId,
  dataSourceId: bedrockStack?.dataSourceId,
  webAclArn: wafStack.webAcl.attrArn,
  domainName,
  hostedZoneId,
  hostedZoneName,
  certificateArn,
  crossRegionReferences: true,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
