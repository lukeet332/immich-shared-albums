# The Rust sidecar image. The build context is the REPO ROOT, not rust/, because the binary embeds
# the committed Preact UI at compile time (rust/src/web/assets.rs include_str!s the repo layout):
#
#   docker build -t immich-shared-albums:live -f rust/Dockerfile .
#
# Pinned by digest: the tag is mutable and this image ships to ghcr, so an unpinned base would let
# the published artefact change with no commit here. Dependabot's docker ecosystem moves the digest.
FROM rust:1-alpine@sha256:7cc1c22d77d9432f7fe012a70e6d3e555af54c2a6832700ed7d553f1769ae89f AS builder
# Debug symbols, off by default. The release profile strips the binary, which is right for what
# ships and useless for a hang: `gdb -p 1 -ex "thread apply all bt"` answers `?? ()` for every frame,
# so a deadlock can be SEEN (every thread in futex_wait) and not NAMED. Build with
#   docker build --build-arg CARGO_PROFILE_RELEASE_STRIP=false #                --build-arg CARGO_PROFILE_RELEASE_DEBUG=1 ...
# to get frames that say which locks are involved. Cargo reads these as profile overrides.
ARG CARGO_PROFILE_RELEASE_STRIP=true
ARG CARGO_PROFILE_RELEASE_DEBUG=0
ENV CARGO_PROFILE_RELEASE_STRIP=${CARGO_PROFILE_RELEASE_STRIP}
ENV CARGO_PROFILE_RELEASE_DEBUG=${CARGO_PROFILE_RELEASE_DEBUG}
# rusqlite builds the bundled SQLite from C, and ring assembles its own crypto: both need a
# toolchain. Alpine's rust image ships rustc but not cc.
RUN apk add --no-cache build-base
WORKDIR /build/rust
# Dependencies are resolved from the lockfile and compiled on their own layer. The stub sources name
# no items, but cargo still builds every dependency in Cargo.toml, so editing src/ does not
# recompile iroh and reqwest.
COPY rust/Cargo.toml rust/Cargo.lock ./
RUN mkdir -p src && touch src/lib.rs && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked --bin isa \
 && rm -rf src
# The UI is committed build output, so no Node stage is needed. It must sit where include_str!
# resolves it: <root>/src/web/dist, one level ABOVE the crate at <root>/rust/.
COPY src/web/dist /build/src/web/dist
COPY rust/src ./src
# HAZARD: COPY stamps the context's mtimes, which are older than the stub build's artefacts, so
# cargo reads every source as unchanged and "succeeds" in 0.3s while leaving the STUB binary in
# place. Touching forces a real rebuild; without it the image silently ships `fn main() {}`.
RUN find src -name '*.rs' -exec touch {} + && cargo build --release --locked --bin isa

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
# wget is not decoration: install.sh probes the health endpoint with `docker compose exec … wget`.
# ca-certificates are needed for an HTTPS Immich and for the n0 relay's TLS.
RUN apk add --no-cache ca-certificates wget \
 && addgroup -g 1000 isa \
 && adduser -D -u 1000 -G isa -h /home/isa isa
COPY --from=builder /build/rust/target/release/isa /usr/local/bin/isa
# /data holds the identity key and every bot API key. Created here so uid 1000 owns it even when the
# volume is anonymous; a bind-mount install must be writable by uid 1000.
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000
VOLUME /data
# 8300/tcp is the addon's HTTP front; 8300/udp is the peer transport (ISA_P2P_PORT), fixed so linked
# servers can find this one again after a restart without waiting on a relay.
EXPOSE 8300
EXPOSE 8300/udp
# Lets `depends_on: condition: service_healthy` work for anything composed in front of the addon.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${ISA_PORT:-8300}/immich-shared-albums/health" || exit 1
CMD ["isa"]
