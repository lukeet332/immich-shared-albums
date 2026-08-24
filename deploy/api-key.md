# The API key

The addon needs one Immich API key, created on an **admin account**. It does not need `all` —
the list below is everything it uses, and the addon checks its key at startup and tells you
exactly what's missing.

In Immich: *Account settings → API keys → New API key*, then tick these:

| Permission | Why the addon needs it |
| :--- | :--- |
| `adminUser.create` / `read` / `update` / `delete` | creates and manages the bot accounts that hold shared photos, so they stay out of your own timeline |
| `album.read` | reads the albums it syncs |
| `albumUser.create` / `update` / `delete` | adds those bot accounts to albums, so shared photos show the right owner |
| `asset.read` | lists what's in an album |
| `asset.view` / `asset.download` | streams your photos to the family you shared them with |
| `activity.read` / `activity.statistics` | syncs comments both ways |
| `user.read` | shows the right names |
| `userProfileImage.read` | syncs avatars, so shared photos show the right face |
| `sharedLink.read` | resolves a share link when someone joins with one |
| `systemConfig.read` / `update` | **only if your Immich is OAuth-only** — briefly toggles password login to set up the bot accounts |

## Why scoped instead of `all`

A key with exactly this list **cannot delete or edit your photos, cannot change server settings,
and cannot create itself a broader key** (`apiKey.*` is deliberately excluded). If the key ever
leaked, the worst it could do is manage the addon's own bot accounts. `all` works too — the addon
doesn't mind — but then a leaked key could do anything.

The CI suite runs entirely on a key with this exact list, so it stays sufficient by proof, not
by promise.

## Where to put it

In the `.env` file next to the addon's `docker-compose.yml`, as `IMMICH_API_KEY`. Never in the
compose file itself.
