# How exposed do you want to be?

Cross-server sharing needs **nothing** of yours reachable from the internet — the sidecars
connect to each other directly, dialling out. So exposure is purely a choice about how *you*
want to reach your own photos and share links, and this page is how to decide, then lock down
whatever you pick.

---

## 1. Pick a posture

| | What's on the internet | Trade-off |
|---|---|---|
| **A. Nothing** *(recommended)* | Nothing at all. | Your own devices need a VPN (Tailscale etc.) to reach your photos away from home. Share links only work at home or on the VPN. |
| **B. Link sharing with immich-public-proxy** | Only [immich-public-proxy](https://github.com/alangrainger/immich-public-proxy) — a read-only gallery for share links. | Same VPN story as A for your own devices. Anyone with a link can view it (plus its password, if set). |
| **C. Fully public** | All of Immich. | Your sign-in page is reachable from the internet — rate-limit it (§2). Share links become joinable by other servers. |

Whatever you pick: **your Immich apps must point at the addon**, not at Immich directly, or
shared photos render as blank placeholders — the byte interceptors live in the addon.

**Posture A needs nothing else from this page** — there's nothing exposed to harden.

**Posture B** publishes exactly one thing. Point immich-public-proxy's `IMMICH_URL` at the
addon (`http://immich-shared-albums:8300`), put your reverse proxy in front of **only** the
proxy's port, and you're done — Immich, the addon and the panel all stay private. The §3
server checklist still applies; §2's Caddy config does not (there's no Immich to front).

The rest of this page is for posture C.

---

## 2. Recommended Caddy config (posture C)

One route sends everything to the sidecar, which passes non-shared traffic through to Immich.
Immich is listed second so a dead sidecar **fails open** — your library keeps working.

```caddy
photos.example.com {
	# --- access log. Nothing else here is verifiable without it. ---
	# Written inside Caddy's own /data volume so it survives container recreates.
	log {
		output file /data/access.log {
			roll_size 20MiB
			roll_keep 10
		}
		format json
	}

	# --- brute-force protection (see the note below about the plugin) ---
	rate_limit {
		zone logins {
			match {
				path /api/auth/login /api/auth/admin-sign-up /api/shared-links/login
			}
			key {remote_host}
			events 5
			window 1m
		}
	}

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}

	# the sidecar speaks JSON only, so a tight body cap is safe HERE
	handle /immich-shared-albums/* {
		request_body {
			max_size 2MB
		}
		reverse_proxy immich-shared-albums:8300 {
			header_up X-Real-IP {remote_host}
		}
	}

	handle {
		reverse_proxy immich-shared-albums:8300 immich-server:2283 {
			lb_policy first
			fail_duration 10s
			header_up X-Real-IP {remote_host}
		}
	}
}
```

Four things worth knowing, each of which bites people:

- **Never put `request_body` at site level.** Immich needs 50GB for uploads. Capping globally
  breaks every photo and video upload, and the failure looks like a flaky network.
- **`rate_limit` is not built into Caddy.** You need a one-off custom image:
  ```dockerfile
  FROM caddy:2-builder AS build
  RUN xcaddy build --with github.com/mholt/caddy-ratelimit
  FROM caddy:2
  COPY --from=build /usr/bin/caddy /usr/bin/caddy
  ```
  Build it (`docker build -t caddy-rl:2 .`) and use `caddy-rl:2` as your Caddy image. If you
  would rather not, delete the `rate_limit` block — everything else works without it.
- **Do not use fail2ban for this.** fail2ban and firewalld filter `INPUT`, but traffic to
  Docker-published ports goes through `FORWARD → DOCKER`. Bans get logged and **never
  enforced**, which is worse than no protection because it looks like it works. That is why
  the rate limiting above is done in Caddy instead.
- **`X-Real-IP` is not set by Caddy automatically.** Without it, anything IP-based sees your
  proxy's container address rather than the real client.

Apply changes with `docker exec caddy caddy reload --config /etc/caddy/Caddyfile` — no
downtime, and it refuses a bad config rather than half-applying it.

Using nginx, Traefik or NPM instead? The single route above translates directly: one
`location /`, one router label, or one proxy host. Only the `handle /immich-shared-albums/*` body cap and
the header lines need their equivalents.

---

## 3. Server checklist

- **Never publish Immich's port.** Delete `ports: - '2283:2283'` from your Immich compose.
  Caddy reaches Immich by container name, so the mapping does nothing except expose plaintext
  HTTP that bypasses your proxy. This is [Immich's own explicit
  warning](https://docs.immich.app/guides/remote-access/).
- **`chmod 600` your `.env`.** It holds an admin API key. If a non-root user needs to run
  `docker compose`, use `chown root:docker` + `chmod 640` instead — the docker group is
  already root-equivalent, so this grants nothing new.
- **Keep Immich patched.** This is your largest real risk and Immich says so themselves. Turn
  on unattended updates, and remember a **reboot** is needed for kernel and glibc fixes.
- **Check what your router actually forwards.** Only 80 and 443 should be. Everything else
  bound to `0.0.0.0` — Cockpit on 9090, SSH, stray test listeners — is exposed if forwarded.

---

## 4. Optional extra for posture C: close sign-in

If you want Immich public but not its sign-in page, add this to your site block. Existing
sessions keep working, so phones already signed in carry on; only *new* sign-ins are blocked
from the internet — new devices sign in at home (or on VPN) the first time.

```caddy
@newlogin path /api/auth/login /api/auth/admin-sign-up /auth/login
handle @newlogin {
	respond "Sign in from your home network" 403
}
```

Do **not** block all of `/api/auth/*` — `status`, `session` and `logout` all need to work for
signed-in clients, and blocking them logs everyone out.

## 5. Joining albums from a share link, in postures A and B

Share links can still be *viewed* publicly through immich-public-proxy, but a stranger's
server can't *join* from one — the join card lives on your (private) share page. In posture A,
someone in your household joins another family's album while home or on the VPN, and linking a
new server is always the pairing code. That's the design, not a limitation to work around.

---

## 6. Check it worked

From a phone on mobile data, or any machine outside your network:

```bash
# only 80/443 should answer
for p in 22 2283 9090 5432; do nc -z -w3 your-public-ip $p && echo "$p OPEN"; done

# headers present, no Server banner
curl -sI https://photos.example.com/ | grep -iE 'strict-transport|x-content-type|referrer'

# the sidecar's admin surface must be closed
curl -s -o /dev/null -w '%{http_code}\n' https://photos.example.com/immich-shared-albums/   # expect 401

# rate limiting bites (expect 401s then 429s)
for i in $(seq 1 8); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST https://photos.example.com/api/auth/login \
    -H 'Content-Type: application/json' -d '{"email":"x@invalid.test","password":"x"}'
done; echo
```

One thing you **cannot** fix: `/api/server/version` is readable without auth, because Immich's
share pages need it. Accept it and keep Immich updated.
