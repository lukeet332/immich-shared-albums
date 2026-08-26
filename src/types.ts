/**
 * Sidecar-to-sidecar protocol types — imported by the runtime and enforced by
 * `npm run typecheck` in CI, so contract drift fails the build before the E2E suite.
 * Identity is the connection itself: every request arrives over mutual-TLS iroh, so the
 * caller's public key is proven by transport, never by headers.
 */

export const PROTOCOL_VERSION = 2;
/** Capability flags a /hello answer may carry. Empty in protocol 2 — the field exists so a
 *  future feature can be sniffed per peer instead of forcing a protocol bump. */
export const PROTOCOL_FEATURES: string[] = [];

/** GET /hello — who are you, protocol-wise. Answered by every peer route table since v1;
 *  callers persist the result per peer and treat a 404 as "protocol 2, no features". */
export type HelloResponse = { protocol: number; version: string; features: string[] };

/** A household = one Immich server + one sidecar + one keypair. */
export type Household = {
  /** Stable identity: base64url ed25519 public key — also the iroh endpoint it answers on. */
  publicKey: string;
  name: string;
};

/** One photo living on its owner's server, referenced into a shared album. */
export type AssetRef = {
  originAsset: string; // asset id on the origin server
  /** An ORIGIN-SUPPLIED opaque content identity (today: Immich's base64 sha1). It is never
   *  verified against fetched bytes and is NOT an integrity check — it exists for dedup and
   *  cross-server loop prevention, where only equality matters. */
  checksum: string;
  /** Which algorithm minted `checksum`. Absent means `sha1-b64`. Receivers must treat refs
   *  with an unrecognised algorithm as opaque-but-usable: dedup still works by equality,
   *  cross-algorithm identity does not (a mixed mesh duplicates rather than errors). */
  checksumAlg?: string;
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
    /** DISPLAY dimensions of the origin photo (orientation already applied). Used only to size the
     *  mirror stub so Immich lays the photo out at the right aspect ratio. Optional per
     *  wire-protocol.md evolution rule 1 — a peer that omits them makes the receiver fall back to the
     *  legacy 1×1 stub, exactly today's behaviour. */
    width?: number;
    height?: number;
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

/** GET /albums/:mappingId/version — cheap change handshake. `version` is an OPAQUE
 *  equality token: members compare it to their cursor and re-pull on mismatch; it is not
 *  ordered and must never be compared with < or >. The structured fields carry what the
 *  legacy packed string ("updatedAt|assetCount") forced receivers to parse out of it. */
export type VersionResponse = {
  version: string;
  updatedAt?: string;
  assetCount?: number;
  comments?: number | null;
};

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
 * Byte endpoints (peer identity proven by the connection; entitlement checked per asset):
 *  /assets/:id/{preview,original,playback} — bytes of an origin asset
 *  /users/:id/avatar                       — contributor profile image
 */
