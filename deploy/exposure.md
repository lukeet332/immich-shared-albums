# How exposed do you want to be?

Cross-server sharing needs *something* of yours reachable from the internet — each household's
sidecar has to reach the others. This page is how to decide what, and how to lock it down.

Everything here is optional. The sidecar is safe to publish as-is; this is about the rest of
your server.

---

## 1. Pick a posture

| | What's on the internet | Trade-off |
|---|---|---|
| **A. Immich public** *(default, most people)* | All of Immich | Your sign-in page is reachable. Rate-limit it — see §2. |
| **B. Immich public, sign-in closed** | All of Immich except sign-in | You sign in once at home. New devices need to be home (or on VPN) the first time. |
| **C. Immich private** | Only shared albums + the sidecar protocol | Everyone in your household needs a VPN to use Immich. Joining albums happens at home. |

**Most people want A plus §2.** Pick C only if you're happy putting a VPN on every family
phone — see §4 before you commit to it.

---

## 2. Recommended Caddy config (any posture)

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
		reverse_proxy immich-shared:8300 {
			header_up X-Real-IP {remote_host}
		}
	}

	handle {
		reverse_proxy immich-shared:8300 immich-server:2283 {
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

## 4. Posture B: close sign-in

Add this to your site block. Existing sessions keep working, so phones already signed in
carry on; only *new* sign-ins are blocked from the internet.

```caddy
@newlogin path /api/auth/login /api/auth/admin-sign-up /auth/login
handle @newlogin {
	respond "Sign in from your home network" 403
}
```

Do **not** block all of `/api/auth/*` — `status`, `session` and `logout` all need to work for
signed-in clients, and blocking them logs everyone out.

## 5. Posture C: keep Immich private

Immich stays on your LAN or VPN and only sharing is published. Two things to know before you
choose it:

- **Your Immich apps must point at the sidecar**, not at Immich, or shared photos render as
  blank placeholders. The byte interceptors live in the sidecar.
- **Joining an album needs local access.** The accept page reads your Immich session cookie,
  and that session lives on the private origin. Sharing *out* works from anywhere; joining
  *in* means being home or on the VPN.

For sharing ordinary Immich links publicly (no cross-server involved),
[immich-public-proxy](https://github.com/alangrainger/immich-public-proxy) is purpose-built
for it and runs happily alongside this sidecar.

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
