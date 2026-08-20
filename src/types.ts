/**
 * Sidecar-to-sidecar protocol types — imported by the runtime and enforced by
 * `npm run typecheck` in CI, so contract drift fails the build before the E2E suite.
 * All POST bodies are signed with the sender's household ed25519 key
 * (headers x-isa-key / x-isa-sig); signed GETs sign the path parameter.
 */

export const PROTOCOL_VERSION = 1;

/** A household = one Immich server + one sidecar + one keypair. */
export type Household = {
  /** Stable identity: base64url ed25519 public key. */
  publicKey: string;
  /** Mutable hint — where to reach the sidecar right now. */
  url: string;
  name: string;
};

/** One photo living on its owner's server, referenced into a shared album. */
export type AssetRef = {
  originAsset: string; // asset id on the origin server
  checksum: string; // sha1 of the original bytes (Immich native)
  contributor: {
    // person, not server — provenance survives mirroring
    displayName: string;
    originUserId: string;
  };
  kind: 'image' | 'video';
  takenAt?: string;
  exif?: {
    // re-applied to the materialised proxy
    latitude?: number;
    longitude?: number;
    description?: string;
    rating?: number;
  };
};

/** POST /immich-shared-albums/api/v1/invites/redeem — consume a share link as a household. */
export type RedeemRequest = {
  shareKey: string; // the Immich share-link key IS the capability
  household: Household; // joiner introduces itself; key pinned on success
};
export type RedeemResponse = {
  household: Household; // owner's identity, pinned by the joiner
  album: { id: string; name: string; permissions: 'view' | 'contribute' };
  albumOwner: { displayName: string; originUserId: string };
  manifest: AssetRef[]; // current human-owned photos; previews fetched separately
  mappingId: string; // quote this in refs/activity/manifest calls
};

/** POST /immich-shared-albums/api/v1/albums/:mappingId/refs — offer new refs to a peer. */
export type RefsUpdate = { add: AssetRef[] };
/** Partial success: the sender re-offers only the failed checksums next cycle. */
export type RefsResult = { ok: boolean; failed: string[] };

/** GET /immich-shared-albums/api/v1/albums/:mappingId/version — cheap change handshake.
 *  Returns the album's updatedAt; members only pull the manifest on mismatch,
 *  so an idle album costs one tiny request per cycle instead of a full scan. */
export type VersionResponse = { version: string };

/** GET /immich-shared-albums/api/v1/albums/:mappingId/manifest — reconciliation sweep.
 *  Members re-pull this each poll and materialise anything missing (heals
 *  refs missed at join time). Human-owned photos only — proxies are excluded
 *  so reconciliation can never echo a household's own photos back. */
export type ManifestResponse = { manifest: AssetRef[] };

/** POST /immich-shared-albums/api/v1/albums/:mappingId/activity — two-way comment sync. */
export type ActivityUpdate = {
  comments: { id: string; comment: string; author: string; authorUserId: string }[];
};

/** POST /immich-shared-albums/api/v1/albums/:albumId/nudge — "this album moved, pull now".
 *  A latency hint, not a data channel: receivers run their normal handshake+pull
 *  immediately instead of at the next tick. Lost nudges cost nothing (fail-open). */
export type NudgeRequest = { album: string };

/**
 * Byte endpoints (signed GETs — signature over the path parameter):
 *  /immich-shared-albums/api/v1/assets/:id/preview   — ~1440px preview of an origin asset
 *  /immich-shared-albums/api/v1/users/:id/avatar     — contributor profile image
 */
