import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies API/WS calls to the Fastify server (docker-compose runs both on separate
// ports). The production build is served directly by that same Fastify server (see
// app/src/server.ts), so no proxy is needed there.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/j": "http://localhost:3000",
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
});
