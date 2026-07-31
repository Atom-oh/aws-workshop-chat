#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { WorkshopChatStack } from "../lib/workshop-chat-stack";
import { WorkshopChatWafStack } from "../lib/waf-stack";

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

new WorkshopChatStack(app, `${workshopName}-WorkshopChat`, {
  workshopName,
  scale,
  bedrockModelId,
  adminUsername,
  participantPassphrase,
  participantCount,
  enableKnowledgeBase,
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
