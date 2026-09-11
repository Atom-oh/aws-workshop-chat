import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import {
  CognitoIdentityProviderClient, AdminInitiateAuthCommand, AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockDatabase } from "./helpers/database.js";

// Configure the existing Cognito wrapper before its module captures deployment variables.
process.env.COGNITO_USER_POOL_ID = "us-east-1_test";
process.env.COGNITO_CLIENT_ID = "test-client";
const { config } = await import("../src/config.js");
const { authRoutes } = await import("../src/routes/auth.js");

for (const mode of ["cognito", "nickname"] as const) {
  test(`${mode} mode keeps Cognito operator authentication and group-based roles`, async (t) => {
    const previous = config.participantAuthMode;
    config.participantAuthMode = mode;
    t.after(() => { config.participantAuthMode = previous; });
    mockDatabase(t);
    t.mock.method(CognitoIdentityProviderClient.prototype, "send", async (command: any) => {
      if (command instanceof AdminInitiateAuthCommand) {
        if (command.input.AuthParameters?.PASSWORD !== "correct-password") throw new Error("NotAuthorizedException");
        return { AuthenticationResult: { AccessToken: "test-token" } };
      }
      if (command instanceof AdminListGroupsForUserCommand) {
        const username = command.input.Username;
        const group = username === "host@ws" ? "admin" : username === "no-group" ? "unrelated" : "participant";
        return { Groups: [{ GroupName: group }] };
      }
      throw new Error("Unexpected Cognito operation");
    });
    const app = Fastify();
    await app.register(fastifyCookie);
    await app.register(authRoutes);
    t.after(() => app.close());
    const login = (id: string, password = "correct-password") =>
      app.inject({ method: "POST", url: "/api/login/id", payload: { id, password } });

    const operator = await login("host@ws");
    assert.equal(operator.statusCode, 200);
    const session = (await app.inject({
      url: "/api/session", cookies: { wc_session: operator.cookies[0].value },
    })).json().session;
    assert.equal(session.role, "operator");
    assert.equal(session.participantId, "operator");
    assert.equal((await login("host@ws", "wrong-password")).statusCode, 403);
    assert.equal((await login("no-group")).statusCode, 403);

    // Typing the configured admin username never grants operator access without that group.
    const participant = await login(config.adminUsername);
    assert.equal(participant.statusCode, mode === "cognito" ? 200 : 403);
    if (mode === "cognito") {
      const participantSession = (await app.inject({
        url: "/api/session", cookies: { wc_session: participant.cookies[0].value },
      })).json().session;
      assert.equal(participantSession.role, "participant");
    } else {
      assert.equal(participant.cookies.length, 0);
    }
  });
}
