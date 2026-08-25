/**
 * config.ts — process configuration, the shared logger, and small string constants.
 * The single source of truth for env-derived settings; every other module reads CFG here.
 *
 * Every variable is ISA_-prefixed: the addon shares compose files with Immich itself (which
 * owns IMMICH_*) and with anything else on the stack (PORT, DATA_DIR are claimed by half the
 * container ecosystem), so an unprefixed name is a collision waiting for a shared env_file.
 *
 * Parsing is strict and fails LOUDLY at boot. A typo'd boolean must never fail open —
 * `ISA_RELAY=flase` refusing to start beats it silently keeping the relay on, and
 * `ISA_SYNC_POLL_MS=20s` becoming NaN would make setInterval fire every tick.
 */

export const SIDECAR_VERSION = '1.0.1'; // x-release-please-version

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const envBool = (name: string, dflt: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return die(`${name}=${raw} is not a boolean — use true/false (or 1/0, yes/no, on/off)`);
};

const envInt = (name: string, dflt: number, min = 0): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min)
    return die(`${name}=${raw} is not a whole number >= ${min}`);
  return n;
};

// Read and check this first: the process cannot run without it, so proving that here once
// means `CFG.apiKey` is a plain `string` everywhere instead of `string | undefined`.
const apiKey = process.env.ISA_IMMICH_API_KEY;
if (!apiKey) die('ISA_IMMICH_API_KEY required');

export const CFG = {
  immichUrl: process.env.ISA_IMMICH_URL || 'http://immich-server:2283',
  apiKey: apiKey as string,
  name: process.env.ISA_HOUSEHOLD_NAME || 'Unnamed household',
  port: envInt('ISA_PORT', 8300, 1),
  dataDir: process.env.ISA_DATA_DIR || '/data',
  // The album/asset watch cadence. Invite detection rides the same tick today; if the two
  // ever want different cadences, mint ISA_INVITE_POLL_MS rather than overloading this one.
  syncPollMs: envInt('ISA_SYNC_POLL_MS', 20000, 1000),
  commentPollMs: envInt('ISA_COMMENT_POLL_MS', 5000, 500),
  // Naming for mirror albums created on this side. Tokens: {name} = the album's name at the
  // origin, {peer} = the sending household's name. The vocabulary is declared here so adding
  // a token later can never change the meaning of an existing template.
  mirrorAlbumTemplate: process.env.ISA_MIRROR_ALBUM_TEMPLATE || '{name}',
  // bounded LRU byte-cache for streamed previews (0 disables). A cache, not storage:
  // capped, reclaimable, invisible to libraries — delete the folder any time.
  cacheMaxMb: envInt('ISA_CACHE_MAX_MB', 512),
  // Hard cap on any request body we will buffer. The router reads bodies before it can
  // know who is calling, so this is the one limit that must not depend on auth.
  maxBodyKb: envInt('ISA_MAX_BODY_KB', 1024, 1),
  // Refuse to enrol a peer SERVER from a share link that carries no password — a gate on
  // JOINING, not on viewing. Recommended whenever the share page is reachable from the
  // public internet: without it, possession of a link is the whole credential. A link's own
  // password and expiry are ALWAYS enforced regardless of this setting.
  linkJoinRequiresPassword: envBool('ISA_LINK_JOIN_REQUIRES_PASSWORD', false),
  // Optional storage cap on the bot accounts that own the stubs (0 = no quota). They only
  // ever store ~2KB per photo and ~2MB per video, so a cap bounds what a stolen bot
  // key could write — but set it too low and materialisation silently starts failing.
  botQuotaMb: envInt('ISA_BOT_QUOTA_MB', 0),
  // PUBLISH the names of local (human) users to linked servers, so they can invite a
  // specific person to an album. Names only — never emails; outbound only (it does not
  // affect consuming a peer's directory). Set false to keep your user list private; because
  // sharing is per person, that disables native invitations from that server entirely
  // (there is nobody to name) and leaves share links as the way in.
  publishUserDirectory: envBool('ISA_PUBLISH_USER_DIRECTORY', true),
  // Relays assist hole-punching and carry end-to-end-encrypted traffic when a direct path
  // fails — the one disclosed third party, and only ever a fallback. false runs dark.
  // Strictly parsed BECAUSE this is the privacy setting: a typo must halt, never fail open.
  relay: envBool('ISA_RELAY', true),
  // Log every sync decision — turn on first when an album looks wrong.
  reconcileDebug: envBool('ISA_RECONCILE_DEBUG', false),
};
export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const UTILITY_SUFFIX = ' (via shared albums)';

/**
 * Email domain for the bot users this addon creates. Named after the project for the same
 * reason ROUTE_PREFIX is: "sidecar" is a generic term another Immich addon could reasonably
 * claim, and these addresses are how we tell our own bots apart from real people.
 *
 * `.invalid` because that TLD exists for exactly this (RFC 2606): deliberately unresolvable,
 * never a real mailbox. `.local` — the previous choice — is mDNS-reserved (RFC 6762) and can
 * trip resolvers and email validators. This rename, like `@sidecar.local` before it, is a
 * ONE-TIME v1.0.0 allowance taken while the install base is ~zero. It is NOT the policy going
 * forward — post-v1, changes to this domain need a migration path.
 *
 * Getting this check wrong is not cosmetic (a bot misread as a human gets added to mirrors and
 * its stubs counted as someone's photos), so the test stays obviously correct by inspection.
 */
export const UTILITY_EMAIL_DOMAIN = 'immich-shared-albums.invalid';

/**
 * ONE local account per remote person, doing both jobs: it owns their mirrored photos, and it is
 * what a human picks in Immich's album picker to share with them.
 *
 * They used to be two accounts, because invitation detection reads "this account is an album
 * member" as human intent, and the sidecar adds accounts to albums itself for attribution.
 * Immich forces that overlap — an album owner adding an asset owned by a NON-member is refused
 * with `no_permission` — so the account must be a member wherever it owns content.
 *
 * The distinction therefore moved out of the namespace and into two explicit records:
 *  - `added` (store.addedRecord) says which memberships WE created, so only a human's counts as
 *    an invitation. Its write order is a security property: record first, add second.
 *  - `Contributor.homePeer` says we actually know which server the person is on, which only a
 *    linked server's directory can tell us. Without it an account is attribution-only.
 *
 * Every bot account is `person-<their user id on their own server>` — nothing is ever keyed by
 * a display name, because names are mutable and collide (two remote people with the same name
 * must never collapse into one local account sharing one API key).
 *
 * `person-` is keyed on the person's user id on THEIR OWN server, so the same human resolves to
 * the same local account whether we meet them through a directory or a relayed photo.
 */
export const BOT_PREFIX = {
  /** One remote person, keyed by their user id on their home server. */
  person: 'person-',
} as const;

/**
 * Display names, by what the user is actually doing when they read them.
 *
 * An invite marker is a DESTINATION you pick in Immich's album picker, so it names the person and
 * the server the album is going to. An attribution contributor is a PHOTO OWNER you see in an
 * album, so it keeps UTILITY_SUFFIX. The two must never collide: a marker and a contributor can
 * exist for the same remote person on the same server, and two identically-named users are
 * unpickable. There is no household-wide marker: a server link is not a person (see p2p/unlink).
 */
/**
 * Recover a person's real name from whatever decoration a local account carries.
 *
 * Accounts here are named for what they are locally — "(via The Smiths server)" for someone on a
 * linked server, "(via shared albums)" for an attribution-only account — but the name that goes
 * ON THE WIRE must be the person's own. Stripping only UTILITY_SUFFIX was not enough once markers
 * carried a server name: the decorated name travelled as the "true" contributor, the receiver
 * appended its own suffix, and the decoration accumulated one layer per relay hop
 * ("Nan (via B server) (via shared albums)"). Greedy on purpose, so a doubled name collapses back
 * to the person in one pass. Callers must gate on the account being a BOT (`utility` flag /
 * isUtilityEmail) — a human genuinely named with a trailing "(via …)" must travel as written.
 */
export const personName = (name?: string) => (name || '').replace(/\s*\(via .*\)\s*$/, '').trim();

export const markerName = {
  // Don't stack "server" when the household is already named one ("Bob's server" becomes
  // "(via Bob's server)", not "(via Bob's server server)"). personName strips any trailing
  // "(via …)" regardless, so this is purely cosmetic and safe.
  person: (personName: string, peerName: string) =>
    `${personName} (via ${peerName}${/servers?\s*$/i.test(peerName) ? '' : ' server'})`,
};

/** Is this one of our bot users? The single source of truth — never inline the check. */
export const isUtilityEmail = (email?: string) => !!email && email.endsWith(`@${UTILITY_EMAIL_DOMAIN}`);

/**
 * The URL prefix this addon owns on the Immich origin.
 *
 * "sidecar" was a generic term staking a claim another Immich addon could reasonably want, so
 * it moved to a name specific to this project. There is deliberately no compatibility shim for
 * the old prefix: the install base was small enough that a clean break beat carrying a second
 * route surface forever. Both peers must run a version that agrees on this — a member's share
 * page probes the ORIGIN's prefix, so it could never be per-install configuration.
 */
export const ROUTE_PREFIX = '/immich-shared-albums';
