FROM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci --ignore-scripts \
    && npm rebuild node-pty --foreground-scripts
COPY tsconfig*.json vite.config.ts ./
COPY server ./server
COPY mail ./mail
COPY calendar ./calendar
COPY google ./google
COPY shared ./shared
COPY web ./web
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM docker.io/library/node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash git curl ca-certificates ripgrep python3 tini isync notmuch libsasl2-modules-kdexoauth2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --chmod=0644 package.json LICENSE ./
COPY skills ./skills
COPY --chmod=0644 mail/README.md ./docs/mail.md
COPY --chmod=0755 scripts/mailctl /usr/local/bin/mailctl
COPY --chmod=0755 scripts/calendarctl /usr/local/bin/calendarctl
COPY --chmod=0755 scripts/googlectl /usr/local/bin/googlectl
COPY --chmod=0644 google/README.md ./docs/google.md
COPY --chmod=0644 calendar/README.md ./docs/calendar.md
COPY --chmod=0755 scripts/pi-mail-token /usr/local/libexec/pi-mail-token
RUN chmod -R a+rX /app/skills && mkdir -p /workspace /data/agent /data/state && chown -R node:node /workspace /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WORKSPACE_DIR=/workspace PI_CODING_AGENT_DIR=/data/agent STATE_DIR=/data/state MAIL_DIR=/data/mail CALENDAR_DIR=/data/calendar PI_TELEMETRY=0
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/main.js"]
