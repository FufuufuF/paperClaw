FROM node:22-bookworm-slim

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    make \
    poppler-utils \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@9.0.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/paper/package.json packages/paper/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY README.md ./README.md

ENV NODE_ENV=production
ENV PAPERCLAW_STORE_DIR=/data
ENV PAPERCLAW_CLI_UI=plain

RUN mkdir -p /data

VOLUME ["/data"]

CMD ["pnpm", "chat"]
