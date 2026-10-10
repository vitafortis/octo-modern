# syntax=docker/dockerfile:1
# Build once on the runner's native platform: the output is plain JS and the
# production dependencies have no native code, so every target arch can reuse it
# (no slow, flaky QEMU emulation during the build).
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml .npmrc ./
# Small fixes to smb3-client (Samba compatibility, ranged reads); see patches/.
COPY patches ./patches
RUN pnpm install --frozen-lockfile
COPY . .
# The release version shown in the sidebar (the image workflow passes it; local builds say -dev).
ARG OCM_VERSION=
ENV OCM_VERSION=$OCM_VERSION
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine
LABEL org.opencontainers.image.source=https://github.com/vitafortis/octo-modern
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    OCM_DATA_DIR=/data \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
# G-code uploads stream through to OctoPrint (never buffered), so allow big ones; the default limit is 512 KB.
ENV BODY_SIZE_LIMIT=4G
# tzdata lets TZ set the time zone used for ETAs in the status API and logs.
RUN apk add --no-cache tzdata
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "build"]
