FROM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig*.json vite.config.ts ./
COPY server ./server
COPY shared ./shared
COPY web ./web
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM docker.io/library/node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash git curl ca-certificates ripgrep python3 tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --chmod=0644 package.json ./
RUN mkdir -p /workspace /data/agent /data/state && chown -R node:node /workspace /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WORKSPACE_DIR=/workspace PI_CODING_AGENT_DIR=/data/agent STATE_DIR=/data/state PI_TELEMETRY=0
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/main.js"]
