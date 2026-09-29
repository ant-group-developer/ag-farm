FROM node:22-bookworm-slim AS base

WORKDIR /app
ENV COREPACK_HOME=/tmp/corepack

RUN corepack enable && corepack prepare yarn@1.22.22 --activate

# ---- Cài dependencies toàn monorepo ----
FROM base AS dependencies

COPY package.json yarn.lock ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/owner-client/package.json ./packages/owner-client/
COPY packages/worker-sdk/package.json ./packages/worker-sdk/
COPY apps/api/package.json ./apps/api/

RUN yarn install --frozen-lockfile

# ---- Build protocol trước, rồi build api ----
FROM dependencies AS build

COPY tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY packages/owner-client ./packages/owner-client
COPY apps/api ./apps/api

RUN yarn workspace @ag-farm/protocol build
RUN yarn workspace @ag-farm/api build

# ---- Production dependencies ----
FROM dependencies AS production-dependencies

RUN yarn install --frozen-lockfile --production=true && yarn cache clean

# ---- Runtime ----
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist

USER node
WORKDIR /app/apps/api
EXPOSE 3010

CMD ["node", "dist/main.js"]
