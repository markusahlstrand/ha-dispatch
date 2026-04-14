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

# Install the s6 service script. HA's base image uses s6-overlay; our
# service is started with 'with-contenv' so SUPERVISOR_TOKEN and other
# Supervisor-injected vars are available to the Node process.
COPY rootfs/ /
RUN chmod a+x /etc/services.d/ha-dispatch/run /etc/services.d/ha-dispatch/finish

# Runtime env
ENV NODE_ENV=production

EXPOSE 8099
