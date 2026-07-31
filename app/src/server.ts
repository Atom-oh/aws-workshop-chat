import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { aiRoutes } from "./routes/ai.js";
import { uploadRoutes } from "./routes/upload.js";
import { exportRoutes } from "./routes/export.js";
import { operatorRoutes } from "./routes/operator.js";
import { subscribe } from "./ws/hub.js";
import { readSession } from "./auth/session.js";
import { seedChannels } from "./bootstrap.js";
import { startSnapshotTimer } from "./export/snapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: true, bodyLimit: 6 * 1024 * 1024 });

await app.register(fastifyCookie);
await app.register(fastifyWebsocket);

// mp4/image uploads go straight to S3 via presigned URL (routes/upload.ts) — this body limit
// is for chat/API JSON payloads only, not media.

await app.register(authRoutes);
await app.register(chatRoutes);
await app.register(aiRoutes);
await app.register(uploadRoutes);
await app.register(exportRoutes);
await app.register(operatorRoutes);

app.get("/ws", { websocket: true }, (socket, req) => {
  const session = readSession(req as any);
  const channel = (req.query as any)?.channel;
  if (!session || !channel) {
    socket.close();
    return;
  }
  subscribe(channel, socket as any);
});

// Static frontend build (vite output). Left out of the docker-compose dev loop, where the
// Vite dev server runs separately on its own port.
const webDist = path.resolve(__dirname, "../../web/dist");
await app.register(fastifyStatic, { root: webDist, wildcard: false });
app.setNotFoundHandler((req, reply) => {
  if (req.raw.url?.startsWith("/api") || req.raw.url?.startsWith("/j")) {
    reply.code(404).send({ error: "not found" });
  } else {
    reply.sendFile("index.html");
  }
});

await seedChannels();
startSnapshotTimer();

app.listen({ port: config.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
