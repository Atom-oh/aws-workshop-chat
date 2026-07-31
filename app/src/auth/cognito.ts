// Thin Cognito wrapper. The Cognito User Pool is the source of truth for participant
// credentials (created at deploy by infra/lib/credentials-provider.ts); this app process only
// needs to *verify* a password against it for the "type your ID and password" login path.
// The one-click /j link and the shared-passphrase fallback never touch Cognito at request
// time — see auth/session.ts and the routes for why.

import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const client = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;

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
