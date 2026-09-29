# Web quản lý ag-farm: build tĩnh bằng Vite rồi phục vụ bằng nginx.
# Build từ gốc monorepo: docker build -f apps/web/Dockerfile .
FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV COREPACK_HOME=/tmp/corepack
RUN corepack enable && corepack prepare yarn@1.22.22 --activate

COPY package.json yarn.lock ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/owner-client/package.json ./packages/owner-client/
COPY packages/worker-sdk/package.json ./packages/worker-sdk/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN yarn install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/web ./apps/web

# Vite nhúng các biến này vào bundle lúc build.
ARG VITE_API_URL
ARG VITE_AUTH0_DOMAIN
ARG VITE_AUTH0_CLIENT_ID
ARG VITE_AUTH0_AUDIENCE
ENV VITE_API_URL=${VITE_API_URL} \
    VITE_AUTH0_DOMAIN=${VITE_AUTH0_DOMAIN} \
    VITE_AUTH0_CLIENT_ID=${VITE_AUTH0_CLIENT_ID} \
    VITE_AUTH0_AUDIENCE=${VITE_AUTH0_AUDIENCE}

RUN yarn workspace @ag-farm/web build

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
