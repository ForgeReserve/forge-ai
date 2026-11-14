# Forge AI gateway. Runs TypeScript directly on Node's built-in type stripping (no build step).
# Base image pinned by digest: Node 24.22.3 slim, the multi-arch index node:24-slim pointed at on
# 2026-11-13 (checked with `docker buildx imagetools inspect`). Both stages use the same reference;
# to move to a newer Node, resolve the new tag's digest the same way and change both lines.
FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production \
    FORGE_DB_PATH=/data/forge.db \
    PORT=8787
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY config ./config
COPY public ./public
# The natural voice (Phonon 31m and its voices, docs/VOICE.md): fetched here at build time when the
# build context does not carry it, pinned by commit and SHA-256 in scripts/phonon/lock.json, then
# served from this origin. The app never fetches it from Hugging Face.
COPY scripts/phonon-model.ts ./scripts/phonon-model.ts
COPY scripts/phonon/lock.json ./scripts/phonon/lock.json
RUN node scripts/phonon-model.ts && rm -rf .tmp
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.ts"]
