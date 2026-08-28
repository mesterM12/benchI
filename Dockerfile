FROM node:24.7.0-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN corepack enable
RUN npm install --global opencode-ai@1.18.23
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
ENV BETTER_AUTH_SECRET=build-only-secret BETTER_AUTH_URL=http://localhost:3000 DATABASE_URL=postgres://build:build@localhost/build
RUN pnpm build

FROM build AS application
ENV NODE_ENV=production
