# The probe image: Node + the repo's JS iroh client, for the lane's independent-protocol oracle.
# The sidecar image must never carry Node (rust/ARCHITECTURE.md), so the oracle is its own image.
# Pinned by digest: an unpinned mutable base would let the oracle change with no commit here.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
# /app, deliberately: the lane mounts the scripts directory at /probe:ro, which shadows anything the
# image put there. The runtime (node_modules) lives at /app, unshadowed, and the oracle resolves its
# iroh from /app/package.json via ISA_ROOT.
WORKDIR /app
# The oracle is a second implementation of the wire: it needs the iroh JS package and nothing else.
# iroh is a devDependency (the product does not use it), so this installs dev deps — the only
# consumer of them, and the image carries no secrets.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY demo/e2e/*.mjs /app/
USER node
