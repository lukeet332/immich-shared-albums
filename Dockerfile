FROM node:24-alpine
WORKDIR /app
# The one production dependency: the iroh peer transport (native, pinned by the lockfile).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# TypeScript runs natively via Node's type stripping, no build step. index.ts is the entry.
COPY src/ ./
# /data holds the identity key and every bot API key — created here so the node user owns it
# even when the volume is anonymous. Bind-mount installs must be writable by uid 1000.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8300
# Lets `depends_on: condition: service_healthy` work for anything composed in front of the addon.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${ISA_PORT:-8300}/immich-shared-albums/health" || exit 1
CMD ["node", "index.ts"]
