# Security policy

The contract for changing this repository is [AGENTS.md](./AGENTS.md).

## Reporting a vulnerability

Use GitHub private vulnerability reporting: **Security → Report a vulnerability** on this repository.
That channel is monitored and keeps the report private until there is a fix.

Do not open a public issue for anything that could expose a household's library, keys, or peers.

## In scope

- The sidecar's HTTP surface, the pairing string, and the QUIC protocol between two peers.
- Key handling: the household ed25519 key and the per-peer bot API keys held in `state.db`.
- The published image, `ghcr.io/lukeet332/immich-shared-albums`.
- Anything that lets a shared photo reach someone the owner did not share it with, or that leaves a
  copy behind after a share is withdrawn.

## Out of scope

- **Immich itself** — report those to
  [immich-app/immich](https://github.com/immich-app/immich/security).
- Operator choices: an over-exposed reverse proxy, a weak Immich password, `RELAY` left at its
  default, or handing `IMMICH_API_KEY` to more than the sidecar.
- Findings that require an attacker to already hold `state.db` or the admin API key.
- The documented costs in [src/ARCHITECTURE.md](./src/ARCHITECTURE.md) ("Where this falls short
  today") — those are known and disclosed, not vulnerabilities.

## Supported versions

Pre-1.0: only the latest release. `README.md` carries the breaking-change warning.
