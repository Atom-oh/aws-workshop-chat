// Thin Cognito wrapper. The Cognito User Pool is the source of truth for participant
// credentials (created at deploy by infra/lib/credentials-provider.ts); this app process only
// needs to *verify* a password against it for the "type your ID and password" login path.
// The one-click /j link and the shared-passphrase fallback never touch Cognito at request
// time — see auth/session.ts and the routes for why.

import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  ListUsersInGroupCommand,
  DescribeUserPoolCommand,
  type AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";

const client = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
export const ADMIN_GROUP = process.env.COGNITO_ADMIN_GROUP ?? "admin";
export const PARTICIPANT_GROUP = process.env.COGNITO_PARTICIPANT_GROUP ?? "participant";

export async function verifyParticipantPassword(participantId: string, password: string): Promise<boolean> {
  if (!USER_POOL_ID || !CLIENT_ID) return false;
  try {
    await client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: USER_POOL_ID,
        ClientId: CLIENT_ID,
        AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: participantId, PASSWORD: password },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export async function userExists(participantId: string): Promise<boolean> {
  if (!USER_POOL_ID) return false;
  try {
    await client.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: participantId }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Role now comes from Cognito group membership (assigned once at creation by the credentials
 * provisioner — see infra/lambda/credentials-handler.ts), not a hardcoded username comparison
 * or a naming convention. Returns null if the username isn't in either expected group.
 */
export async function getUserRole(username: string): Promise<"admin" | "participant" | null> {
  if (!USER_POOL_ID) return null;
  const res = await client.send(new AdminListGroupsForUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
  const groups = new Set((res.Groups ?? []).map((g) => g.GroupName));
  if (groups.has(ADMIN_GROUP)) return "admin";
  if (groups.has(PARTICIPANT_GROUP)) return "participant";
  return null;
}

// Whether this pool's Username is an opaque generated ID (real ID lives in the `email`
// attribute) or the ID itself, decided once from the pool's own UsernameAttributes config —
// not guessed per-user from attribute *presence*. Guessing per-user is unsafe: a
// signInAliases:{username:true} pool (this repo's own CDK stack, standardAttributes: {}) never
// has an email attribute, but nothing stops some other deployment's schema from carrying an
// unrelated/unset email field that would otherwise get misread as the real ID, or — worse —
// collapse two different participants who happen to share that attribute's value.
let usernameIsEmailCache: Promise<boolean> | undefined;
async function getUsernameIsEmail(): Promise<boolean> {
  if (!usernameIsEmailCache) {
    // A transient DescribeUserPool failure must not poison this cache forever — clear it on
    // rejection so the next call retries instead of every roster/attendance request failing
    // until the process restarts.
    usernameIsEmailCache = client
      .send(new DescribeUserPoolCommand({ UserPoolId: USER_POOL_ID }))
      .then((res) => (res.UserPool?.UsernameAttributes ?? []).includes("email"))
      .catch((err) => {
        usernameIsEmailCache = undefined;
        throw err;
      });
  }
  return usernameIsEmailCache;
}

// Login-usable ID from a Cognito user's Username/attributes, given whether this pool's
// UsernameAttributes makes Username itself an opaque generated ID (see usernameIsEmail above).
// AdminInitiateAuth/AdminListGroupsForUser accept either shape as USERNAME, so this still lines
// up with the rest of this file either way.
export function participantIdOf(username: string, attributes: AttributeType[] | undefined, usernameIsEmail: boolean): string {
  if (!usernameIsEmail) return username;
  const email = attributes?.find((a) => a.Name === "email")?.Value;
  if (!email) throw new Error(`Cognito user ${username} has no email attribute despite UsernameAttributes=[email]`);
  return email;
}

/**
 * The source of truth for "who is a participant" — this app never creates participants
 * itself; depending on how it's deployed, either this repo's credentials-provisioner Lambda
 * or an external poller (sync-cognito) populates the `participant` group. So the roster isn't
 * a derived calculation, it's a live query.
 *
 * Returns null when Cognito isn't configured at all (local dev with no user pool) — that's the
 * one case callers should fall back to a derived roster. Any other failure (e.g. missing
 * ListUsersInGroup permission) is thrown, not swallowed — an operator console showing a
 * fabricated headcount because a lookup silently failed is exactly the bug this replaces.
 */
export async function listParticipantIds(): Promise<string[] | null> {
  if (!USER_POOL_ID) return null;
  const usesEmailUsername = await getUsernameIsEmail();
  const ids: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListUsersInGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: PARTICIPANT_GROUP, NextToken: nextToken }),
    );
    for (const u of res.Users ?? []) {
      if (u.Username) ids.push(participantIdOf(u.Username, u.Attributes, usesEmailUsername));
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return ids;
}
