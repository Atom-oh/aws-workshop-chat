// §9 load test. Opens N WebSocket clients subscribed to one channel, has one of them post
// messages, and measures how many clients receive each broadcast and how long it takes.
// Usage: npx tsx test/load.ts --url http://localhost:3000 --clients 60 --messages 20
//
// This is deliberately a script, not a test-runner suite: it talks to a real running server
// (local or deployed) rather than mocking anything, which is the point of a load test.

import WebSocket from "ws";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const BASE_URL = arg("url", "http://localhost:3000");
const CLIENT_COUNT = Number(arg("clients", "60"));
const MESSAGE_COUNT = Number(arg("messages", "20"));
const CHANNEL = arg("channel", "chat");
const PASSPHRASE = arg("passphrase", "dev-passphrase");

const wsBase = BASE_URL.replace(/^http/, "ws");

async function loginAndGetCookie(participantId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/login/passphrase`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ participantId, passphrase: PASSPHRASE }),
  });
  if (!res.ok) throw new Error(`login failed for ${participantId}: ${res.status}`);
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie returned");
  return cookie.split(";")[0];
}

async function main() {
  console.log(`[load] connecting ${CLIENT_COUNT} clients to ${wsBase}/ws?channel=${CHANNEL}`);

  const clients = await Promise.all(
    Array.from({ length: CLIENT_COUNT }, (_, i) => {
      const participantId = String(900000000000 + i).padStart(12, "0");
      return loginAndGetCookie(participantId).then(
        (cookie) =>
          new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(`${wsBase}/ws?channel=${CHANNEL}`, { headers: { cookie } });
            ws.on("open", () => resolve(ws));
            ws.on("error", reject);
          }),
      );
    }),
  );
  console.log(`[load] all ${clients.length} clients connected`);

  const received = new Array(clients.length).fill(0);
  clients.forEach((ws, i) => ws.on("message", () => received[i]++));

  const posterCookie = await loginAndGetCookie("900000000000");
  const latencies: number[] = [];

  for (let m = 0; m < MESSAGE_COUNT; m++) {
    const start = Date.now();
    const before = received.slice();
    await fetch(`${BASE_URL}/api/channels/${CHANNEL}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: posterCookie },
      body: JSON.stringify({ body: `load-test message ${m}`, kind: "msg" }),
    });
    // wait until every client has seen this broadcast, or a 2s timeout
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (received.every((count, i) => count > before[i])) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    latencies.push(Date.now() - start);
    const delivered = received.filter((count, i) => count > before[i]).length;
    if (delivered < clients.length) {
      console.warn(`[load] message ${m}: only ${delivered}/${clients.length} clients received it within 2s`);
    }
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  console.log(`[load] broadcast latency — p50=${p50}ms p95=${p95}ms (n=${latencies.length})`);

  clients.forEach((ws) => ws.close());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
