// In-container WebSocket broadcast, replacing AppSync Events (see plan's §7 deviation).
// ponytail: known ceiling — a Map<channel, Set<socket>> only works within one process. Single
// Fargate task (desiredCount 1) makes that the actual deployment, so this is not a shortcut
// that will bite; if horizontal scaling is ever needed, fan out via DynamoDB Streams instead.

// ponytail: typed as `any` rather than pulling in `ws`'s types as a direct dependency for one
// interface — @fastify/websocket hands us a raw `ws` socket, and all we use is
// readyState/OPEN/send/ping/on("close").
type Socket = any;

const channelSockets = new Map<string, Set<Socket>>();
const PING_INTERVAL_MS = 60_000; // well under CloudFront's 10-minute idle timeout

export function subscribe(channel: string, socket: Socket) {
  if (!channelSockets.has(channel)) channelSockets.set(channel, new Set());
  channelSockets.get(channel)!.add(socket);

  const ping = setInterval(() => {
    if (socket.readyState === socket.OPEN) socket.ping();
  }, PING_INTERVAL_MS);

  socket.on("close", () => {
    clearInterval(ping);
    channelSockets.get(channel)?.delete(socket);
  });
}

export function broadcast(channel: string, event: unknown) {
  const sockets = channelSockets.get(channel);
  if (!sockets) return;
  const payload = JSON.stringify(event);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}
