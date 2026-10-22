# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# SimTrade Demo - image build. The platform is simulation-only: no payment
# provider, no external API calls, all state in SQLite.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 is optional at runtime (node:sqlite is the fallback), so we do
# not run install scripts inside the image build.
RUN npm ci --ignore-scripts

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home appuser
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY migrations ./migrations
RUN mkdir -p data/uploads data/backups && chown -R appuser:appuser /app
USER appuser
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/server.js"]
