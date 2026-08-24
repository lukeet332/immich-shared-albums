# How exposed do you want to be?

Cross-server sharing needs **nothing** of yours reachable from the internet — the sidecars
connect to each other directly, dialling out. So exposure is purely a choice about how *you*
want to reach your own photos and share links. This page is how to decide, plus the two things
the addon changes about hosting. Everything else — reverse proxies, TLS, tunnels, port
forwarding, rate limiting — is ordinary Immich hosting, and the guides that already exist for
it apply unchanged:

- [Immich: remote access](https://docs.immich.app/guides/remote-access/) — VPNs, tunnels, and
  when to use which
- [Immich: reverse proxy](https://docs.immich.app/administration/reverse-proxy/) — proxy
  configs and the upload-size traps
- [immich-public-proxy](https://github.com/alangrainger/immich-public-proxy) — hosting the
  share-link gallery, with configs for the common setups

---

## 1. Pick a posture

| | What's on the internet | Trade-off |
|---|---|---|
| **A. Nothing** *(recommended)* | Nothing at all. | Your own devices need a VPN (Tailscale etc.) to reach your photos away from home. Share links only work at home or on the VPN. |
| **B. Link sharing with immich-public-proxy** | Only [immich-public-proxy](https://github.com/alangrainger/immich-public-proxy) — a read-only gallery for share links. | Same VPN story as A for your own devices. Anyone with a link can view it (plus its password, if set). |
| **C. Fully public** | All of Immich. | Your sign-in page is reachable from the internet. Share links become joinable by other servers. |

---

## 2. What the addon changes about hosting

Two things, and only these — after them, treat your setup as a vanilla Immich (posture C) or
Immich + immich-public-proxy (posture B) and follow the guides above as written.

1. **Your Immich apps point at the addon, not at Immich directly** — otherwise shared photos
   render as blank placeholders, because the byte interceptors live in the addon. Concretely:
   wherever a hosting guide says to point something at Immich's port (`2283`), point it at the
   addon's port (`8300`) instead. The addon passes everything else through unchanged,
   websockets included, and if it's ever down you can point back at Immich directly — nothing
   is held hostage.
2. **immich-public-proxy's `IMMICH_URL` points at the addon too**
   (`http://immich-shared-albums:8300`, not `immich-server:2283`) — that is what makes photos
   shared from other servers render full quality in public links.

Addon-specific settings worth flipping per posture:

- **Posture B:** in the panel, switch *"Allow other Immich users to join albums via shared
  links"* **off** — links stay strictly view-only, and servers link to yours by pairing code
  alone.
- **Posture C:** set `ISA_LINK_JOIN_REQUIRES_PASSWORD: "true"` on the addon, so a forwarded share link
  with no password can't be used to introduce a stranger's server.
- **Any posture:** `chmod 600` the `.env` holding the API key. If a non-root user needs
  `docker compose`, use `chown root:docker` + `chmod 640` instead — the docker group is
  already root-equivalent, so this grants nothing new.

---

## 3. Joining albums from a share link, in postures A and B

Share links can still be *viewed* publicly through immich-public-proxy, but a stranger's
server can't *join* from one — the join card lives on your (private) share page. In postures A
and B, someone in your household joins another family's album while home or on the VPN, and
linking a new server is always the pairing code. That's the design, not a limitation to work
around.

---

## 4. Check the addon's surface

Whatever posture you picked, from outside your network the addon's admin surface must demand a
session:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://your-public-address/immich-shared-albums/   # expect 401
```

Everything reachable under `/immich-shared-albums/` without a signed-in Immich session returns
401 by design — the addon has no accounts or passwords of its own. For checking the rest of
your exposure (open ports, headers, rate limits), Immich's own hardening guidance applies —
the addon adds no surface beyond the paths above.
