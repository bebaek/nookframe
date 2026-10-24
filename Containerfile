FROM docker.io/library/node:24-trixie-slim AS build
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

FROM docker.io/library/node:24-trixie-slim
# Trusted personal development/admin workstation; no container daemon or sudo.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash git curl ca-certificates ripgrep python3 python-is-python3 python3-yaml make g++ pkg-config \
    gh openssh-client age jq rsync less procps unzip chromium \
    fonts-noto-cjk fonts-noto-color-emoji \
    tini isync notmuch libsasl2-modules-kdexoauth2 \
    && rm -rf /var/lib/apt/lists/*
# This image is published for linux/amd64. Pin standalone tools by version and hash.
RUN test "$(dpkg --print-architecture)" = amd64 \
    && curl -fsSL https://dl.k8s.io/release/v1.36.2/bin/linux/amd64/kubectl -o /usr/local/bin/kubectl \
    && echo '1e9045ec32bea85da43de85f0065358529ea7c7a152eca78154fba5b58c27d82  /usr/local/bin/kubectl' | sha256sum -c - \
    && curl -fsSL https://github.com/getsops/sops/releases/download/v3.13.3/sops-v3.13.3.linux.amd64 -o /usr/local/bin/sops \
    && echo 'e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b  /usr/local/bin/sops' | sha256sum -c - \
    && chmod 0755 /usr/local/bin/kubectl /usr/local/bin/sops
ENV BROWSER_EXECUTABLE_PATH=/usr/bin/chromium PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --chmod=0644 package.json LICENSE ./
COPY skills ./skills
COPY --chmod=0644 mail/README.md ./docs/mail.md
COPY --chmod=0755 scripts/mailctl /usr/local/bin/mailctl
COPY --chmod=0755 scripts/imagectl /usr/local/bin/imagectl
COPY --chmod=0755 scripts/calendarctl /usr/local/bin/calendarctl
COPY --chmod=0755 scripts/googlectl /usr/local/bin/googlectl
COPY --chmod=0755 scripts/nookframe /usr/local/bin/nookframe
COPY --chmod=0644 google/README.md ./docs/google.md
COPY --chmod=0644 calendar/README.md ./docs/calendar.md
COPY --chmod=0755 scripts/pi-mail-token /usr/local/libexec/pi-mail-token
RUN chmod -R a+rX /app/skills /app/docs && mkdir -p /workspace /data/agent /data/state && chown -R node:node /workspace /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WORKSPACE_DIR=/workspace PI_CODING_AGENT_DIR=/data/agent STATE_DIR=/data/state MAIL_DIR=/data/mail CALENDAR_DIR=/data/calendar PI_TELEMETRY=0
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/main.js"]
