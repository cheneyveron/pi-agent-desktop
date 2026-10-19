# Web server image published to ghcr.io/cheneyveron/pi-agent-desktop by
# .github/workflows/docker-image.yml. It runs the browser/remote-backend server
# only; the Tauri desktop shell is built by the signed release workflow.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client python3 make g++ ripgrep ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY bin/prepare-terminal.js ./bin/prepare-terminal.js
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/cheneyveron/pi-agent-desktop" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production
USER node
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "8511"]
