# Stage 1: install deps + build (TS -> dist/, frontend TS -> public/bundle.js)
FROM node:22-slim AS build
WORKDIR /app

# Native build tools for better-sqlite3's node-gyp fallback if no prebuilt
# binary matches this image's Node ABI/arch.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund --prefer-offline

COPY tsconfig.json esbuild.config.mjs ./
COPY src/ src/
COPY frontend/ frontend/
COPY public/ public/
RUN npm run build

# Prune devDependencies so only production deps ship in the runtime stage.
RUN npm prune --omit=dev

# Stage 2: slim runtime image
FROM node:22-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash cuearcode
USER cuearcode
WORKDIR /app

COPY --from=build --chown=cuearcode:cuearcode /app/node_modules node_modules/
COPY --from=build --chown=cuearcode:cuearcode /app/dist dist/
COPY --from=build --chown=cuearcode:cuearcode /app/public public/
COPY --chown=cuearcode:cuearcode package.json ./

ARG APP_VERSION=dev
LABEL org.opencontainers.image.version="${APP_VERSION}"

ENV CUEARCODE_HOST=0.0.0.0
ENV CUEARCODE_PORT=7900
ENV CUEARCODE_DB_PATH=/app/data/cuearcode.db
ENV CUEARCODE_LOG_LEVEL=info
ENV NODE_ENV=production

# Intended to be mounted as a volume — see DEPLOY.md.
VOLUME ["/app/data"]

EXPOSE 7900

CMD ["node", "dist/server.js"]
