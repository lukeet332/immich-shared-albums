# Configuration reference

Only `ISA_IMMICH_API_KEY` is required. Everything else has a working default — set these only
if you need to. For the key's permission list, see [api-key.md](./api-key.md).

Every setting is `ISA_`-prefixed so the addon can never collide with Immich's own variables
(or anything else's) in a shared env file. Booleans accept `true`/`false` (also `1`/`0`,
`yes`/`no`, `on`/`off`) — anything else refuses to start rather than silently picking a side.

| Variable | Default | What it does |
|---|---|---|
| `ISA_IMMICH_API_KEY` | — | **Required.** A key on an admin account, created with the permission list in [api-key.md](./api-key.md). The addon checks the key when it starts and tells you if something is missing. `all` works too. |
| `ISA_HOUSEHOLD_NAME` | `Unnamed household` | The name other servers see. |
| `ISA_IMMICH_URL` | `http://immich-server:2283` | Your Immich, from inside the container. |
| `ISA_PORT` | `8300` | Port the addon listens on inside the container (map any host port onto it). |
| `ISA_DATA_DIR` | `/data` | Where `state.db` lives. Back this up; it holds this server's identity key — and copy the whole directory, not just `state.db` (its WAL sidecar files carry recent writes). |
| `ISA_LINK_JOIN_REQUIRES_PASSWORD` | `false` | Refuse to let another *server* join from a share link that has no password. A gate on joining, not viewing — a link's own password and expiry are always enforced. Worth setting if your Immich is public. |
| `ISA_PUBLISH_USER_DIRECTORY` | `true` | Publish your users' names (never emails) to linked servers so they can be picked in the share menu. `false` keeps your user list private and disables native invitations from those servers, leaving share links. |
| `ISA_RELAY` | `true` | If two servers can't connect directly (roughly 1 network in 10), traffic falls back through a public relay run by [n0](https://n0.computer). The relay only ever sees encrypted bytes. `false` means direct connections only. |
| `ISA_MIRROR_ALBUM_TEMPLATE` | `{name}` | Naming for mirror albums created on this side. Tokens: `{name}` = the album's name, `{peer}` = the sending household — e.g. `{name} (from {peer})`. |
| `ISA_CACHE_MAX_MB` | `512` | Cache for recently viewed shared photos. `0` disables it. Safe to delete any time. |
| `ISA_BOT_QUOTA_MB` | `0` (none) | Storage cap for the addon's bot accounts. They store ~2KB per photo and ~2MB per video, so size it well above your shared volume — too low and syncing silently starts failing. |
| `ISA_MAX_BODY_KB` | `1024` | Cap on request bodies the addon buffers. |
| `ISA_SYNC_POLL_MS` | `20000` | How often it checks linked servers for changes. |
| `ISA_COMMENT_POLL_MS` | `5000` | How often the comment sync checks for new activity. |
| `ISA_RECONCILE_DEBUG` | `false` | Log every sync decision. Turn this on first if an album looks wrong. |
