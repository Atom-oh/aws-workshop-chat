# Multi-stage build: web (Vite) -> app (tsc) -> slim runtime. Built from the repo root so both
# workspaces are reachable: `docker build -f app/Dockerfile .`
FROM node:22-slim AS web-build
WORKDIR /repo
COPY web/package.json web/package.json
RUN cd web && npm install
COPY web/ web/
RUN cd web && npm run build

FROM node:22-slim AS app-build
WORKDIR /repo
COPY app/package.json app/package.json
RUN cd app && npm install
COPY app/ app/
RUN cd app && npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=app-build /repo/app/package.json ./package.json
RUN npm install --omit=dev
COPY --from=app-build /repo/app/dist ./dist
COPY --from=web-build /repo/web/dist ../web/dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
