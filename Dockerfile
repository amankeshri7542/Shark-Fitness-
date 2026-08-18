# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — build the two front ends.
# This stage needs the full dependency tree (vite, tailwind, typescript) and
# is discarded afterwards; none of it reaches the published image.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

ENV CI=true
WORKDIR /app/shark-fitness
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

COPY shark-fitness/package.json shark-fitness/pnpm-lock.yaml shark-fitness/pnpm-workspace.yaml shark-fitness/.npmrc shark-fitness/tsconfig.base.json ./
COPY shark-fitness/apps ./apps
COPY shark-fitness/packages ./packages
COPY shark-fitness/infrastructure ./infrastructure

RUN pnpm install --frozen-lockfile
RUN pnpm build

# ---------------------------------------------------------------------------
# Stage 2 — resolve production dependencies only.
# A fresh --prod install from the manifests, rather than pruning the build
# stage's tree, so what lands here is defined entirely by the lockfile. Only
# the manifests are copied first, so this layer is reused whenever application
# code changes but dependencies do not.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS prod-deps

ENV CI=true
WORKDIR /app/shark-fitness
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

COPY shark-fitness/package.json shark-fitness/pnpm-lock.yaml shark-fitness/pnpm-workspace.yaml shark-fitness/.npmrc ./
COPY shark-fitness/apps/api/package.json ./apps/api/
COPY shark-fitness/apps/member-pwa/package.json ./apps/member-pwa/
COPY shark-fitness/apps/admin-web/package.json ./apps/admin-web/
COPY shark-fitness/packages/contracts/package.json ./packages/contracts/
COPY shark-fitness/packages/domain/package.json ./packages/domain/
COPY shark-fitness/packages/design-tokens/package.json ./packages/design-tokens/

RUN pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
# Stage 3 — runtime.
# Carries production dependencies, the API's TypeScript sources (tsx runs them
# directly), the two built front ends and the migration SQL. No compilers, no
# test runners, no front-end toolchain.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    CI=true \
    PORT=8787 \
    SHARK_SERVE_STATIC=true \
    SHARK_DB=/tmp/shark-fitness/shark.db

WORKDIR /app/shark-fitness
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

# Dependency trees (root plus each workspace project) resolved in stage 2.
COPY --from=prod-deps /app/shark-fitness/node_modules ./node_modules
COPY --from=prod-deps /app/shark-fitness/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /app/shark-fitness/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=prod-deps /app/shark-fitness/packages/domain/node_modules ./packages/domain/node_modules

# Workspace manifests, so pnpm still resolves @shark/* the way it does in dev.
COPY shark-fitness/package.json shark-fitness/pnpm-workspace.yaml shark-fitness/pnpm-lock.yaml shark-fitness/.npmrc shark-fitness/tsconfig.base.json ./
COPY shark-fitness/apps/api/package.json shark-fitness/apps/api/tsconfig.json ./apps/api/
COPY shark-fitness/packages/contracts/package.json ./packages/contracts/
COPY shark-fitness/packages/domain/package.json ./packages/domain/

# Application sources and migration SQL. @shark/contracts and @shark/domain
# both resolve to ./src/index.ts, so their TypeScript has to ship.
COPY shark-fitness/apps/api/src ./apps/api/src
COPY shark-fitness/packages/contracts/src ./packages/contracts/src
COPY shark-fitness/packages/domain/src ./packages/domain/src
COPY shark-fitness/infrastructure ./infrastructure

# Built front ends. server.ts resolves these as ../../<app>/dist from
# apps/api/src, so the paths below are load-bearing.
COPY --from=build /app/shark-fitness/apps/member-pwa/dist ./apps/member-pwa/dist
COPY --from=build /app/shark-fitness/apps/admin-web/dist ./apps/admin-web/dist

COPY docker-entrypoint.sh /usr/local/bin/shark-entrypoint
RUN chmod +x /usr/local/bin/shark-entrypoint

# The database lives outside the image; the node user must be able to write it.
RUN mkdir -p /tmp/shark-fitness && chown -R node:node /tmp/shark-fitness /app
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["shark-entrypoint"]
