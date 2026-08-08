FROM node:22-bookworm-slim AS build

WORKDIR /app/shark-fitness
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

COPY shark-fitness/package.json shark-fitness/pnpm-lock.yaml shark-fitness/pnpm-workspace.yaml shark-fitness/tsconfig.base.json ./
COPY shark-fitness/apps ./apps
COPY shark-fitness/packages ./packages
COPY shark-fitness/infrastructure ./infrastructure
COPY shark-fitness/docs ./docs

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8787 \
    SHARK_SERVE_STATIC=true \
    SHARK_DB=/tmp/shark-fitness/shark.db

WORKDIR /app/shark-fitness
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

COPY --from=build /app/shark-fitness /app/shark-fitness
COPY docker-entrypoint.sh /usr/local/bin/shark-entrypoint
RUN chmod +x /usr/local/bin/shark-entrypoint

EXPOSE 8787
ENTRYPOINT ["shark-entrypoint"]
