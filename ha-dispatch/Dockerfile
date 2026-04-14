ARG BUILD_FROM=node:20-alpine
FROM $BUILD_FROM

ENV LANG=C.UTF-8 \
    NODE_ENV=production

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json package-lock.json* ./

# Install runtime + build deps (we'll prune build deps after the bundle)
RUN npm install --no-audit --no-fund

# Copy source and build the bundle
COPY tsconfig.json build.js ./
COPY src ./src
RUN node build.js

# Drop dev dependencies; sql.js is a runtime dep so it stays
RUN npm prune --omit=dev

EXPOSE 8099

CMD ["node", "dist/index.js"]
