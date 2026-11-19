# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:24.14.1-bookworm-slim AS webui

WORKDIR /src
RUN npm install -g pnpm@10.32.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.node.base.json ./
COPY crates/virtual-core/package.json crates/virtual-core/package.json
COPY crates/agent-ui/package.json crates/agent-ui/package.json
COPY crates/agent-gui/package.json crates/agent-gui/package.json
COPY crates/agent-gateway/web/package.json crates/agent-gateway/web/package.json
COPY crates/cloud-executor/package.json crates/cloud-executor/package.json
# Frozen installation reads the workspace patch before resolving any packages.
COPY patches/@extend-ai__react-xlsx@0.19.0.patch patches/
RUN pnpm install --frozen-lockfile --filter @liveagent/gateway-webui...

# The vendored @tanstack/virtual-core ships TypeScript source (exports point
# at src/ and types/), so the build stage needs the whole package.
COPY crates/virtual-core crates/virtual-core
COPY crates/agent-ui crates/agent-ui
COPY crates/agent-gateway/web crates/agent-gateway/web
COPY scripts/vite-resource-preview-assets.mjs scripts/vite-resource-preview-assets.d.mts scripts/
COPY docs/licenses/duke-sheets-MIT.txt docs/licenses/
ARG ZEROAGENT_APP_VERSION
# The bundled public catalog imports the canonical plugin metadata at build time.
RUN --mount=type=bind,source=crates/agent-gateway/internal/account/skills,target=/src/crates/agent-gateway/internal/account/skills \
    ZEROAGENT_APP_VERSION="$ZEROAGENT_APP_VERSION" pnpm --filter @liveagent/gateway-webui build

FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS gateway-builder

# Keep these ARGs bare: a default value shadows the per-platform values buildx injects.
ARG TARGETOS
ARG TARGETARCH

WORKDIR /src/crates/agent-gateway

COPY crates/agent-gateway/go.mod crates/agent-gateway/go.sum ./
RUN go mod download

COPY crates/agent-gateway ./
COPY --from=webui /src/crates/agent-gateway/web/dist ./web/dist

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/liveagent-gateway ./cmd/gateway
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/cloud-space-storage ./cmd/cloud-space-storage
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/cloud-space-quota ./cmd/cloud-space-quota

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --system --uid 10001 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin zeroagent \
    && install -d -o zeroagent -g zeroagent -m 0700 /var/lib/zeroagent

COPY --from=gateway-builder /out/liveagent-gateway /usr/local/bin/liveagent-gateway
COPY --from=gateway-builder /out/cloud-space-storage /usr/local/bin/cloud-space-storage
COPY --from=gateway-builder /out/cloud-space-quota /usr/local/bin/cloud-space-quota

USER zeroagent

ENV PORT=8080 \
    ZEROAGENT_GATEWAY_DATA_DIR=/var/lib/zeroagent

VOLUME ["/var/lib/zeroagent"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent --show-error http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/liveagent-gateway"]
