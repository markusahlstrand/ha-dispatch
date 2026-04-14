ARG BUILD_FROM=ghcr.io/hassio-addons/base-nodejs:latest
FROM $BUILD_FROM

ENV LANG=C.UTF-8

WORKDIR /app

# Copy package manifests first for caching
COPY package.json package-lock.json* ./

RUN npm install --omit=dev --no-audit --no-fund \
  && npm install esbuild typescript tsx @types/node --no-save --no-audit --no-fund

# Copy source
COPY tsconfig.json build.js ./
COPY src ./src

# Build the bundle
RUN node build.js

# Prune dev tooling
RUN npm prune --omit=dev

# HA Ingress exposes this port
EXPOSE 8099

CMD ["node", "dist/index.js"]
