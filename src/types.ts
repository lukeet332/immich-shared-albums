/** types.ts — the shapes that travel between servers. See types.md. */
export const PROTOCOL_VERSION = 1;

export type Household = {
  publicKey: string;
  url: string;
  name: string;
};

export type AssetRef = {
  originAsset: string; // asset id on the origin server
  checksum: string; // sha1 of the original bytes (Immich native)
  contributor: {
    displayName: string;
    originUserId: string;
  };
  kind: 'image' | 'video';
  takenAt?: string;
  exif?: {
    latitude?: number;
    longitude?: number;
    description?: string;
    rating?: number;
  };
};

/** POST /immich-shared-albums/api/v1/invites/redeem — consume a share link as a household. */
export type RedeemRequest = {
  shareKey: string; // the Immich share-link key IS the capability
  household: Household;
};
export type RedeemResponse = {
  household: Household;
  album: { id: string; name: string; permissions: 'view' | 'contribute' };
  albumOwner: { displayName: string; originUserId: string };
  manifest: AssetRef[];
  mappingId: string;
};

/** POST /immich-shared-albums/api/v1/albums/:mappingId/refs — offer new refs to a peer. */
export type RefsUpdate = { add: AssetRef[] };
export type RefsResult = { ok: boolean; failed: string[] };

/** GET /immich-shared-albums/api/v1/albums/:mappingId/version — cheap change handshake. */
export type VersionResponse = { version: string };

/** GET /immich-shared-albums/api/v1/albums/:mappingId/manifest — reconciliation sweep. */
export type ManifestResponse = { manifest: AssetRef[] };

/** POST /immich-shared-albums/api/v1/albums/:mappingId/activity — two-way comment sync. */
export type ActivityUpdate = {
  comments: { id: string; comment: string; author: string; authorUserId: string }[];
};

/** POST /immich-shared-albums/api/v1/albums/:albumId/nudge — "this album moved, pull now". */
export type NudgeRequest = { album: string };
