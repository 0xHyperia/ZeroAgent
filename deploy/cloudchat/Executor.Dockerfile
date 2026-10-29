# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.14.1-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /build
RUN npm install --global pnpm@10.32.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY crates/agent-ui/package.json crates/agent-ui/package.json
COPY crates/agent-gui/package.json crates/agent-gui/package.json
COPY crates/agent-gateway/web/package.json crates/agent-gateway/web/package.json
COPY crates/virtual-core/package.json crates/virtual-core/package.json
COPY crates/cloud-executor/package.json crates/cloud-executor/package.json
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @zeroagent/cloud-executor

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
RUN groupadd --system --gid 10001 zeroagent \
    && useradd --system --uid 10001 --gid zeroagent --home-dir /nonexistent --shell /usr/sbin/nologin zeroagent \
    && install -d -o zeroagent -g zeroagent -m 0700 /var/lib/zeroagent/cloud-executor
COPY --from=dependencies /build/node_modules ./node_modules
COPY --from=dependencies /build/crates/cloud-executor/node_modules ./crates/cloud-executor/node_modules
COPY crates/cloud-executor/package.json ./crates/cloud-executor/package.json
COPY crates/cloud-executor/src ./crates/cloud-executor/src
COPY crates/cloud-executor/sandbox/file_broker.py crates/cloud-executor/sandbox/file_parser.py crates/cloud-executor/sandbox/archive_extract.py ./crates/cloud-executor/sandbox/
COPY deploy/cloudchat/executor-healthcheck.mjs ./executor-healthcheck.mjs
USER zeroagent
ENV ZEROAGENT_CLOUD_EXECUTOR_HOST=127.0.0.1 \
    ZEROAGENT_CLOUD_EXECUTOR_PORT=17843 \
    ZEROAGENT_CLOUD_EXECUTOR_DATA_DIR=/var/lib/zeroagent/cloud-executor
VOLUME ["/var/lib/zeroagent/cloud-executor"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "/app/executor-healthcheck.mjs"]
CMD ["node", "crates/cloud-executor/src/main.ts"]
