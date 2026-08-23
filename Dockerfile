FROM node:24-alpine
WORKDIR /app
# The one production dependency: the iroh peer transport (native, pinned by the lockfile).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# TypeScript runs natively via Node's type stripping, no build step. index.ts is the entry.
COPY src/ ./
VOLUME /data
EXPOSE 8300
CMD ["node", "index.ts"]
