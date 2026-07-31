#!/usr/bin/env -S npx tsx
// Operator CLI (§ops, docs/ssm-integration.md): produces the same participant join links the
// operator console's roster screen shows (app/src/routes/operator.ts), but from the command
// line — useful right after `cdk deploy`, before anyone has opened the console, or for
// generating a printable/emailable list without a browser.
//
// Reuses the exact derivation + token logic the app and the deploy-time credentials provisioner
// already use (same pattern as infra/lambda/credentials-handler.ts importing from app/src):
// same seed in -> same participantId/join-url out, so this can never drift from what actually
// works to log in.

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { writeFile } from "node:fs/promises";
import QRCode from "qrcode";
import { deriveParticipantId } from "../app/src/auth/credentials.js";
import { issueToken } from "../app/src/auth/token.js";
import { config } from "../app/src/config.js";

interface Args {
  count: number;
  baseUrl: string;
  secretArn?: string;
  region?: string;
  out: string;
  passphrase?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const count = Number(get("--count"));
  const baseUrl = get("--base-url");
  if (!count || !baseUrl) {
    console.error(
      "Usage: npm run gen-links -- --count <N> --base-url <https://app-url> --secret-arn <arn> [--region <region>] [--out <dir>] [--passphrase <text>]",
    );
    process.exit(1);
  }
  return {
    count,
    baseUrl: baseUrl.replace(/\/$/, ""),
    secretArn: get("--secret-arn"),
    region: get("--region"),
    out: get("--out") ?? ".",
    passphrase: get("--passphrase"),
  };
}

/** Same source of truth as infra/lib/workshop-chat-stack.ts's `CredentialSeedArn` output. */
async function resolveSeed(args: Args): Promise<string> {
  if (!args.secretArn) {
    console.error("--secret-arn is required (see the CredentialSeedArn stack output).");
    process.exit(1);
  }
  const client = new SecretsManagerClient({ region: args.region });
  const res = await client.send(new GetSecretValueCommand({ SecretId: args.secretArn }));
  if (!res.SecretString) throw new Error("CredentialSeed secret has no SecretString");
  return res.SecretString;
}

function buildJoinUrl(baseUrl: string, seed: string, participantId: string): string {
  const exp = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds;
  const token = issueToken({ participantId, role: "participant", exp }, seed);
  return `${baseUrl}/j?t=${encodeURIComponent(token)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = await resolveSeed(args);

  const roster = await Promise.all(
    Array.from({ length: args.count }, async (_, i) => {
      const participantId = deriveParticipantId(seed, i);
      const joinUrl = buildJoinUrl(args.baseUrl, seed, participantId);
      const qr = await QRCode.toDataURL(joinUrl, { width: 240 });
      return { participantId, joinUrl, qr };
    }),
  );

  const csv = ["participantId,joinUrl", ...roster.map((r) => `${r.participantId},${r.joinUrl}`)].join("\n");
  await writeFile(`${args.out}/roster.csv`, csv, "utf8");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Workshop join links</title>
<style>
  body { font-family: sans-serif; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin-bottom: 8px; display: flex; align-items: center; gap: 12px; }
  .card img { width: 120px; height: 120px; }
  .card a { word-break: break-all; }
</style></head>
<body>
<h1>Workshop join links (${roster.length})</h1>
${args.passphrase ? `<p>Fallback passphrase (if a link doesn't work): <code>${args.passphrase}</code></p>` : ""}
${roster
  .map(
    (r) =>
      `<div class="card"><img src="${r.qr}" alt="QR for ${r.participantId}"><div><strong>${r.participantId}</strong><br><a href="${r.joinUrl}">${r.joinUrl}</a></div></div>`,
  )
  .join("\n")}
</body></html>`;
  await writeFile(`${args.out}/roster.html`, html, "utf8");

  console.log(`Wrote ${roster.length} join links to ${args.out}/roster.csv and ${args.out}/roster.html`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
