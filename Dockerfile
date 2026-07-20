# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f

ARG VCS_REF=""
ARG SOURCE_CODE_URL="https://github.com/GoByeBye/LayerRelay"

LABEL org.opencontainers.image.title="LayerRelay" \
    org.opencontainers.image.description="Self-hosted Prusa printer monitoring dashboard with camera, telemetry, BG-code timelines, and an optional OBS overlay" \
    org.opencontainers.image.source="${SOURCE_CODE_URL}" \
    org.opencontainers.image.revision="${VCS_REF}" \
    org.opencontainers.image.licenses="AGPL-3.0-or-later"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        gosu \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && gosu bun:bun true

ENV NODE_ENV=production \
    CONFIG_PATH=/tmp/layer-relay/config.json \
    DATA_DIR=/data \
    LAYER_RELAY_IMAGE_SOURCE_CODE_URL=${SOURCE_CODE_URL}

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun . .
COPY --chmod=0755 --chown=root:root scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /config /data \
    && chown bun:bun /data

# The entrypoint needs narrowly scoped startup privileges to read a host-owned
# 0600 config and prepare /data. It permanently drops to `bun` before Tini and
# the application start; Compose supplies only the four capabilities it needs.
USER root

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["gosu", "bun:bun", "bun", "-e", "const p=process.env.PORT||process.env.LAYER_RELAY_PORT||8787;const r=await fetch('http://127.0.0.1:'+p+'/healthz',{signal:AbortSignal.timeout(4000)});if(!r.ok||(await r.json()).ok!==true)process.exit(1)"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "server.js"]
