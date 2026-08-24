# Configuration reference

Only `IMMICH_API_KEY` is required. Everything else has a working default — set these only if you
need to. For the key's permission list, see the table in the [README](../README.md#the-api-key).

| Variable | Default | What it does |
|---|---|---|
| `IMMICH_API_KEY` | — | **Required.** A key on an admin account, created with the permission list in the README. The addon checks the key when it starts and tells you if something is missing. `all` works too. |
| `HOUSEHOLD_NAME` | `Unnamed household` | The name other servers see. |
| `IMMICH_URL` | `http://immich-server:2283` | Your Immich, from inside the container. |
| `PORT` | `8300` | Port the addon listens on. |
| `DATA_DIR` | `/data` | Where `state.db` lives. Back this up; it holds your signing key. |
| `REQUIRE_SHARE_PASSWORD` | `false` | Refuse share-link joins when the link has no password. Worth setting if your Immich is public. |
| `SHARE_USER_DIRECTORY` | `true` | Share your users' names (never emails) with linked servers so they can be picked in the share menu. `false` keeps your user list private and disables that, leaving share links. |
| `RELAY` | on | If two servers can't connect directly (roughly 1 network in 10), traffic falls back through a public relay run by [n0](https://n0.computer). The relay only ever sees encrypted bytes. `off` means direct connections only. |
| `ALBUM_TEMPLATE` | `{name}` | Naming for shared albums on your side, e.g. `{name} (shared)`. |
| `CACHE_MAX_MB` | `512` | Cache for recently viewed shared photos. `0` disables it. Safe to delete any time. |
| `UTILITY_QUOTA_MB` | `0` (none) | Storage cap for the addon's bot accounts. |
| `MAX_BODY_KB` | `1024` | Cap on request bodies the addon buffers. |
| `POLL_MS` | `20000` | How often it checks linked servers for changes. |
| `COMMENT_POLL_MS` | `5000` | How often the comment sync checks for new activity. |
| `RECONCILE_DEBUG` | off | Set `1` to log every sync decision. Turn this on first if an album looks wrong. |
