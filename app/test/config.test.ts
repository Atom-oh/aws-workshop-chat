import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("participant entry defaults to Cognito and rejects unknown deployment modes", () => {
  const moduleUrl = new URL("../src/config.ts", import.meta.url).href;
  const script = `const {config} = await import(${JSON.stringify(moduleUrl)}); console.log(config.participantAuthMode);`;
  for (const [value, expected] of [[undefined, "cognito"], ["cognito", "cognito"], ["nickname", "nickname"], ["nicknme", null], ["", null]]) {
    const env = { ...process.env };
    if (value === undefined) delete env.PARTICIPANT_AUTH_MODE;
    else env.PARTICIPANT_AUTH_MODE = value!;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env, encoding: "utf8",
    });
    if (expected) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), expected);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PARTICIPANT_AUTH_MODE must be cognito or nickname/);
    }
  }
});
