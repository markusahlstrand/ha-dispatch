ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG=C.UTF-8

# HA base is Alpine; install Node + npm from Alpine packages
RUN apk add --no-cache nodejs npm

WORKDIR /app

# Copy package manifests first for layer caching.
# NODE_ENV is intentionally left unset here so devDependencies (esbuild,
# typescript) are installed for the bundle step.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# Copy source and build the bundle
COPY tsconfig.json build.js ./
COPY src ./src
RUN node build.js

# Drop dev dependencies after bundling; sql.js is a runtime dep so it stays.
RUN npm prune --omit=dev

ENV NODE_ENV=production

EXPOSE 8099

CMD ["node", "dist/index.js"]
