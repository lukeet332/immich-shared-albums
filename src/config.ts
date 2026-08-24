/**
 * config.ts — process configuration, the shared logger, and small string constants.
 * The single source of truth for env-derived settings; every other module reads CFG here.
 */

export const SIDECAR_VERSION = '0.5.0'; // x-release-please-version
// Read and check this first: the process cannot run without it, so proving that here once
// means `CFG.apiKey` is a plain `string` everywhere instead of `string | undefined`.
const apiKey = process.env.IMMICH_API_KEY;
if (!apiKey) {
  console.error('IMMICH_API_KEY required');
  process.exit(1);
}

export const CFG = {
  immichUrl: process.env.IMMICH_URL || 'http://immich-server:2283',
  apiKey,
  name: process.env.HOUSEHOLD_NAME || 'Unnamed household',
  port: Number(process.env.PORT || 8300),
  dataDir: process.env.DATA_DIR || '/data',
  pollMs: Number(process.env.POLL_MS || 20000),
  template: process.env.ALBUM_TEMPLATE || '{name}',
  // bounded LRU byte-cache for streamed previews (0 disables). A cache, not storage:
  // capped, reclaimable, invisible to libraries — delete the folder any time.
  cacheMaxMb: Number(process.env.CACHE_MAX_MB ?? 512),
  // Hard cap on any request body we will buffer. The router reads bodies before it can
  // know who is calling, so this is the one limit that must not depend on auth.
  maxBodyKb: Number(process.env.MAX_BODY_KB ?? 1024),
  // Refuse to enrol a peer from a share link that carries no password. Recommended
  // whenever the sidecar is reachable from the public internet: without it, possession
  // of a link is the whole credential. A link's own password and expiry are ALWAYS
  // enforced regardless of this setting.
  requireSharePassword: process.env.REQUIRE_SHARE_PASSWORD === 'true',
  // Optional storage cap on the bot users that own the stubs (0 = no quota). They only
  // ever store ~2KB per photo and ~2MB per video, so a cap bounds what a stolen utility
  // key could write — but set it too low and materialisation silently starts failing.
  utilityQuotaMb: Number(process.env.UTILITY_QUOTA_MB ?? 0),
  // Share the names of local (human) users with linked servers, so they can invite a specific
  // person to an album. Names only — never emails. Set false to keep your user list private;
  // because sharing is per person, that disables native invitations from that server entirely
  // (there is nobody to name) and leaves share links as the way in.
  shareUserDirectory: process.env.SHARE_USER_DIRECTORY !== 'false',
};
export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const UTILITY_SUFFIX = ' (via shared albums)';

/**
 * Email domain for the bot users this addon creates. Named after the project for the same
 * reason ROUTE_PREFIX is: "sidecar" is a generic term another Immich addon could reasonably
 * claim, and these addresses are how we tell our own bots apart from real people.
 *
 * A clean break from the old `@sidecar.local`: no rename migration, no dual-domain acceptance.
 * That was a ONE-TIME v1.0.0 allowance, taken because the install base was ~zero and a legacy
 * bridge here would be permanent maintenance. It is NOT the policy going forward — post-v1,
 * changes to this domain need a migration path.
 *
 * Getting this check wrong is not cosmetic (a bot misread as a human gets added to mirrors and
 * its stubs counted as someone's photos), so the test stays obviously correct by inspection.
 */
export const UTILITY_EMAIL_DOMAIN = 'immich-shared-albums.local';

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
 *  - `Contributor.directory` says we actually know which server the person is on, which only a
 *    linked server's directory can tell us. Without it an account is attribution-only.
 *
 * `person-` is keyed on the person's user id on THEIR OWN server, so the same human resolves to
 * the same local account whether we meet them through a directory or a relayed photo.
 */
export const BOT_PREFIX = {
  /** One remote person, keyed by their user id on their home server. */
  person: 'person-',
  /** Album-owner stand-ins and other non-person helpers. */
  contributor: 'shared-',
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
 * to the person in one pass.
 */
export const personName = (name?: string) => (name || '').replace(/\s*\(via .*\)\s*$/, '').trim();

export const markerName = {
  person: (personName: string, peerName: string) => `${personName} (via ${peerName} server)`,
};

/** Is this one of our bot users? The single source of truth — never inline the check. */
export const isUtilityEmail = (email?: string) => !!email && email.endsWith(`@${UTILITY_EMAIL_DOMAIN}`);

/**
 * The URL prefix this addon owns on the Immich origin.
 *
 * "sidecar" was a generic term staking a claim another Immich addon could reasonably want, so
 * it moved to a name specific to this project. There is deliberately no compatibility shim for
 * the old prefix: the install base was small enough that a clean break beat carrying a second
 * route surface forever. Both peers must run a version that agrees on this.
 */
export const ROUTE_PREFIX = '/immich-shared-albums';
