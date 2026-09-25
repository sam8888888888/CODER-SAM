# One application container: API, built web assets, SQLite, backup tooling.
FROM node:22-bookworm-slim AS web-build
WORKDIR /build/web
COPY coder-dashboard/package*.json ./
RUN npm ci
COPY coder-dashboard/ ./
RUN npm run build

FROM node:22-bookworm-slim AS api-build
WORKDIR /build/api
COPY coder-platform/package*.json ./
RUN npm ci
COPY coder-platform/ ./
RUN npm run build:api

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3400 DATA_DIR=/app/data PUBLIC_DIR=/app/public
WORKDIR /app
COPY coder-platform/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=api-build /build/api/dist/api ./dist/api
# Butir 61: soal benchmark tetap harus ikut ke image (dibaca saat berjalan, bukan saat build).
COPY --from=api-build /build/api/apps/api/benchmark ./apps/api/benchmark
COPY --from=web-build /build/web/dist ./public
RUN mkdir -p /app/data /app/backups && chown -R node:node /app
USER node
EXPOSE 3400
CMD ["node", "dist/api/server.js"]
