#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { WorkshopChatStack } from "../lib/workshop-chat-stack";
import { WorkshopChatWafStack } from "../lib/waf-stack";
import { WorkshopChatBedrockStack } from "../lib/bedrock-stack";

const app = new App();

// §10: every deploy-time knob comes from --context, nothing is hardcoded. Region and account
// come from the CLI's resolved environment (CDK_DEFAULT_REGION/ACCOUNT) so the same template
// deploys anywhere a Central Account happens to sit — see the deploy command in README.md.
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

// The guide-docs bucket is owned by the main stack, but the Bedrock stack's S3 data source needs
// its ARN and the main stack needs the Bedrock stack's KB id — a real circular dependency between
// two CDK stacks. Broken by giving the bucket a deterministic name computed here (before either
// stack exists) instead of letting CDK auto-generate one, so its ARN is just a string, not a
// cross-stack reference. See workshop-chat-stack.ts's GuideBucket construct.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const guideBucketName = `${workshopName}-guide-${account}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
const guideBucketArn = `arn:aws:s3:::${guideBucketName}`;

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
      guideBucketArn,
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
  guideBucketName,
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
