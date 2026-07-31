// CloudFormation Custom Resource handler behind the credentials provisioner (Phase 4 / §5.1).
// Reuses the pure derivation + idempotency logic from app/src/auth/credentials.ts — bundled by
// NodejsFunction's esbuild, not duplicated here.
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  TooManyRequestsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { provisionCredentials } from "../../app/src/auth/credentials.js";

const cognito = new CognitoIdentityProviderClient({});
const cloudwatch = new CloudWatchClient({});
const secretsManager = new SecretsManagerClient({});

// CloudFormation dynamic references ({{resolve:secretsmanager:...}}) are NOT resolved in custom
// resource properties (AWS docs: "Dynamic references can't be used for secure values ... in
// custom resources") — passing a secret's value directly as a property silently passes the
// literal unresolved token string instead. The stack passes ARNs; this fetches the real values.
async function fetchSecret(secretArn: string): Promise<string> {
  const res = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!res.SecretString) throw new Error(`secret ${secretArn} has no SecretString`);
  return res.SecretString;
}

async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let delay = 200;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof TooManyRequestsException) || attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  throw new Error("unreachable");
}

async function userExists(userPoolId: string, participantId: string): Promise<boolean> {
  try {
    await withBackoff(() =>
      cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: participantId })),
    );
    return true;
  } catch (err: any) {
    if (err?.name === "UserNotFoundException") return false;
    throw err;
  }
}

async function createUser(userPoolId: string, participantId: string, password: string): Promise<void> {
  await withBackoff(() =>
    cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: participantId,
        MessageAction: "SUPPRESS", // no email/SMS — this is a pseudonymous, non-contactable identity
      }),
    ),
  );
  await withBackoff(() =>
    cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: participantId,
        Password: password,
        Permanent: true, // skip FORCE_CHANGE_PASSWORD (§5.1)
      }),
    ),
  );
}

/** Wires the pure derivation logic to real Cognito calls for one deploy/re-deploy. */
async function runProvisioning(count: number, seed: string, userPoolId: string) {
  return provisionCredentials({
    seed,
    count,
    userExists: (id) => userExists(userPoolId, id),
    createUser: (id, pw) => createUser(userPoolId, id, pw),
  });
}

interface CfnRequest {
  RequestType: "Create" | "Update" | "Delete";
  ResourceProperties: {
    UserPoolId: string;
    SeedArn: string;
    ParticipantCount: string;
    AdminUsername: string;
    AdminPasswordArn: string;
  };
}

export async function handler(event: CfnRequest) {
  if (event.RequestType === "Delete") {
    // Cognito users are deleted along with the User Pool itself on stack destroy — nothing to do.
    return { PhysicalResourceId: "credentials-provider" };
  }

  const { UserPoolId, SeedArn, ParticipantCount, AdminUsername, AdminPasswordArn } = event.ResourceProperties;
  const count = Number(ParticipantCount);
  const [seed, adminPassword] = await Promise.all([fetchSecret(SeedArn), fetchSecret(AdminPasswordArn)]);

  // The one operator account. Always set the password to match the current secret value —
  // unlike participants (many, derived, never meant to change once handed out), there's exactly
  // one of these, so keeping it in sync with whatever's in Secrets Manager (e.g. after a manual
  // rotation) is more useful than "idempotent forever."
  if (await userExists(UserPoolId, AdminUsername)) {
    await withBackoff(() =>
      cognito.send(
        new AdminSetUserPasswordCommand({ UserPoolId, Username: AdminUsername, Password: adminPassword, Permanent: true }),
      ),
    );
  } else {
    await createUser(UserPoolId, AdminUsername, adminPassword);
  }

  // ponytail: a plain sequential-with-retry loop, not Step Functions Map — this is one Lambda
  // invocation reused on every re-run (Create on first deploy, Update on `cdk deploy` again
  // with a raised count), and 500 participants finishes well inside a single Lambda timeout
  // even without added concurrency. Reach for Step Functions only if this needs to survive
  // Lambda's 15-min cap. If AdminCreateUser exhausts its backoff and throws, the whole
  // invocation fails, CFN reports the failure, and the next `cdk deploy` retries from scratch —
  // idempotent, so nothing already created gets duplicated or lost.
  const result = await runProvisioning(count, seed, UserPoolId);

  // Every index 0..count-1 is either newly created or already existed, so created+skipped
  // equals `count` on a successful run — this metric exists to catch the failure case where
  // the Lambda times out or throws partway, in which case CFN never reaches this line at all
  // and the operator sees a stack failure instead of a silently-wrong number.
  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: "WorkshopChat",
      MetricData: [
        { MetricName: "RequestedParticipants", Value: count, Unit: "Count" },
        { MetricName: "RegisteredParticipants", Value: result.created.length + result.skipped.length, Unit: "Count" },
      ],
    }),
  );

  return {
    PhysicalResourceId: "credentials-provider",
    Data: { Created: result.created.length, Skipped: result.skipped.length, Total: count },
  };
}
