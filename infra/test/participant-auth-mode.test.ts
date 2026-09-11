import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Match, Template } from "aws-cdk-lib/assertions";

const infraDir = path.resolve(__dirname, "..");
const defaultContext = {
  ...JSON.parse(readFileSync(path.join(infraDir, "cdk.json"), "utf8")).context,
  workshopName: "auth-mode-test",
  bedrockModelId: "test-model",
  participantPassphrase: "test-passphrase",
  participantCount: "120",
  enableKnowledgeBase: "false",
  "availability-zones:account=123456789012:region=us-east-1": ["us-east-1a", "us-east-1b"],
};

function synth(environmentMode?: string, context: Record<string, unknown> = {}, requiredContext = true) {
  const outdir = mkdtempSync(path.join(tmpdir(), "workshop-chat-auth-test-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CDK_DEFAULT_ACCOUNT: "123456789012",
    CDK_DEFAULT_REGION: "us-east-1",
    CDK_OUTDIR: outdir,
    CDK_CONTEXT_JSON: JSON.stringify({ ...(requiredContext ? defaultContext : {}), ...context }),
    AWS_EC2_METADATA_DISABLED: "true",
  };
  // Do not inherit a developer's chosen mode in the default-mode case.
  delete env.PARTICIPANT_AUTH_MODE;
  if (environmentMode !== undefined) env.PARTICIPANT_AUTH_MODE = environmentMode;
  try {
    // Run the real CDK entry point with cached AZs: no AWS lookups or deployment.
    // Type checking is separate (npx tsc --noEmit).
    const result = spawnSync(
      process.execPath,
      ["--require", require.resolve("ts-node/register/transpile-only"), "bin/app.ts"],
      { cwd: infraDir, env, encoding: "utf8", timeout: 60_000 },
    );
    assert.ifError(result.error);
    const files = readdirSync(outdir);
    const templatePath = path.join(outdir, "auth-mode-test-WorkshopChat.template.json");
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      files,
      template: result.status === 0 ? Template.fromJSON(JSON.parse(readFileSync(templatePath, "utf8"))) : undefined,
    };
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

function assertMode(result: ReturnType<typeof synth>, mode: string, provisionedCount: number) {
  assert.equal(result.status, 0, result.output);
  const template = result.template!;
  for (const [Name, Value] of Object.entries({
    PARTICIPANT_AUTH_MODE: mode,
    PARTICIPANT_COUNT: "120",
    COGNITO_USER_POOL_ID: Match.anyValue(),
    COGNITO_CLIENT_ID: Match.anyValue(),
    PUBLIC_APP_URL: template.toJSON().Outputs.AppUrl.Value,
  })) {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: "app", Environment: Match.arrayWith([{ Name, Value }]) }),
      ]),
    });
  }
  template.hasResourceProperties("AWS::CloudFormation::CustomResource", {
    ParticipantCount: provisionedCount,
    AdminUsername: "admin@ws",
    AdminGroupName: "admin",
    AdminPasswordArn: Match.anyValue(),
    SeedArn: Match.anyValue(),
  });
  template.resourceCountIs("AWS::Cognito::UserPool", 1);
  template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
  template.resourceCountIs("AWS::Cognito::UserPoolGroup", 2);
  return template;
}

test("default Cognito and nickname modes preserve resource IDs and operator authentication", () => {
  const cognito = assertMode(synth(), "cognito", 120);
  const nickname = assertMode(synth("nickname"), "nickname", 0);
  const resourceTypes = (template: Template) =>
    Object.fromEntries(Object.entries(template.toJSON().Resources).map(([id, resource]) => [
      id, (resource as { Type: string }).Type,
    ]));
  assert.deepEqual(resourceTypes(nickname), resourceTypes(cognito));
  for (const type of [
    "AWS::Cognito::UserPool",
    "AWS::Cognito::UserPoolClient",
    "AWS::Cognito::UserPoolGroup",
    "AWS::SecretsManager::Secret",
  ]) {
    assert.deepEqual(nickname.findResources(type), cognito.findResources(type));
  }
  assert.deepEqual(nickname.toJSON().Outputs, cognito.toJSON().Outputs);
});

test("explicit context overrides the environment in both directions", () => {
  assertMode(synth("nickname", { participantAuthMode: "cognito" }), "cognito", 120);
  assertMode(synth("cognito", { participantAuthMode: "nickname" }), "nickname", 0);
  assertMode(synth("unsupported", { participantAuthMode: "cognito" }), "cognito", 120);
});

test("nickname share links use the HTTPS custom domain when configured", () => {
  const template = assertMode(synth("nickname", {
    domainName: "chat.example.com",
    hostedZoneId: "Z0123456789",
    hostedZoneName: "example.com",
    certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/test",
  }), "nickname", 0);
  assert.equal(template.toJSON().Outputs.AppUrl.Value, "https://chat.example.com");
});

test("invalid environment values fail before required-context checks or asset generation", () => {
  for (const value of ["unsupported", "", "NICKNAME", "nickname "]) {
    const result = synth(value, {}, false);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /PARTICIPANT_AUTH_MODE/);
    assert.match(result.output, /cognito.*nickname/);
    assert.doesNotMatch(result.output, /Missing required --context/);
    assert.deepEqual(result.files, []);
  }
});

test("invalid explicit context never falls back to a valid environment", () => {
  for (const value of ["unsupported", "", false, null]) {
    const result = synth("nickname", { participantAuthMode: value }, false);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /participantAuthMode/);
    assert.doesNotMatch(result.output, /Missing required --context/);
    assert.deepEqual(result.files, []);
  }
});

test("nickname deploys still require the unrelated participantPassphrase context", () => {
  const result = synth("nickname", { participantPassphrase: undefined });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Missing required --context participantPassphrase/);
  assert.deepEqual(result.files, []);
});
