# @packdev/agents self-hosted CLI — forge-agnostic (GitHub, Gitea, or a
# custom PROVIDER_MODULE), no GitHub dependency required at runtime.
# Usage: docker run -e REPO=... -e PROVIDER=gitea -e ... <image> compat --once

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
# git is required at runtime: repoSync.ts (clone/fetch) and prepareWorkspace
# both shell out to the real `git` binary — not present in node:alpine by
# default.
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN addgroup -S packdev && adduser -S packdev -G packdev \
    && mkdir -p /app/.packdev-agents && chown -R packdev:packdev /app
USER packdev
ENTRYPOINT ["node", "dist/cli/index.js"]
