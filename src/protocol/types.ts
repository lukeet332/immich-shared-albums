/**
 * Sidecar-to-sidecar protocol types.
 * All requests between sidecars are JSON bodies signed with the sender's
 * household key (detached ed25519 signature over method|path|body|timestamp).
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
  originAsset: string;      // asset id on the origin server
  checksum: string;         // sha1 of the original bytes (Immich native)
  contributor: {            // person, not server — provenance survives mirroring
    displayName: string;
    originUserId: string;
  };
  kind: 'image' | 'video';
  /** live/motion photos are two files; both halves or neither */
  motionPartChecksum?: string;
  takenAt?: string;
  exifStripped: boolean;    // origin's share-link privacy setting, honoured downstream
};

/** POST /sidecar/api/v1/invites/redeem — consume a share link as a household. */
export type RedeemRequest = {
  v: typeof PROTOCOL_VERSION;
  shareKey: string;         // the Immich share-link key IS the capability
  household: Household;     // joiner introduces itself; key pinned on success
};
export type RedeemResponse = {
  v: typeof PROTOCOL_VERSION;
  household: Household;     // owner's identity, pinned by the joiner
  album: { id: string; name: string; permissions: 'view' | 'contribute' };
  manifest: AssetRef[];     // current state; previews fetched separately
};

/** POST /sidecar/api/v1/albums/:id/refs — register/remove references. */
export type RefsUpdate = {
  v: typeof PROTOCOL_VERSION;
  add: AssetRef[];
  remove: string[];         // origin asset ids
};

/** GET /sidecar/api/v1/albums/:id/manifest — reconciliation sweep. */
export type ManifestResponse = {
  v: typeof PROTOCOL_VERSION;
  refs: AssetRef[];
};

/**
 * Byte endpoints (signed GETs):
 *  /sidecar/api/v1/assets/:checksum/preview   — ~1440px, always available
 *  /sidecar/api/v1/assets/:checksum/original  — true bytes, for save-to-library
 */
