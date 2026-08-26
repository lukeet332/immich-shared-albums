/**
 * immich/materialise.ts — writing (and un-writing) proxy assets. materialiseRef pulls a
 * kilobyte stub and files it under the right contributor; deleteProxyAsset removes one,
 * hard-guarded so only utility-owned proxies are ever deleted.
 */
import crypto from 'node:crypto';
import { log } from '../config.ts';
import { state, seenHas, seenAdd, storeSharedAssetsLocally } from '../state.ts';
import { peerByteRequest, recvIterable } from '../p2p/transport.ts';
import { STUB_JPEG, immichJson, jsonBody, uploadAsset, addToAlbum, applyRefMetadata } from './client.ts';
import { ensureContributor } from './contributors.ts';
import { jpegOfSize } from '../media/jpeg.ts';

// Store-shared-locally: cap on a full copy we will buffer into heap. Bigger originals (long 4K
// videos) keep the hotlink stub instead — buffering GB on a small box is worse than one asset
// staying streamed. Photos and phone videos sit well under this.
const MAX_FULL_BYTES = 256 * 1024 * 1024;
// Content-type -> extension for a full copy (Immich types an upload by its filename extension, and
// full originals are not all JPEG). Falls back by kind for anything unlisted.
const CT_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
  'image/x-adobe-dng': 'dng',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
};

/** Fetch the whole original from the owner for a local full copy. 'retry' = transient failure (try
 *  again next cycle); 'toobig' = over the buffer cap, so the caller keeps a stub instead. */
export async function fetchFullOriginal(
  peer,
  ref,
  mappingId: string
): Promise<{ bytes: Buffer; ext: string } | 'retry' | 'toobig'> {
  const r = await peerByteRequest(peer, `/assets/${ref.originAsset}/original`, undefined, mappingId);
  if (r.status >= 400) {
    log(`full-copy fetch failed for ${ref.originAsset}: ${r.status}`);
    return 'retry';
  }
  const parts: Buffer[] = [];
  let got = 0;
  for await (const chunk of recvIterable(r.recv)) {
    got += chunk.length;
    if (got > MAX_FULL_BYTES) return 'toobig';
    parts.push(chunk);
  }
  const ct = String(r.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return { bytes: Buffer.concat(parts), ext: CT_EXT[ct] || (ref.kind === 'video' ? 'mp4' : 'jpg') };
}

// Fetch a ref's preview from the peer and create the local proxy copy. Returns
// false (without marking seen) on failure so reconciliation can retry later.
//
// IN-FLIGHT GUARD: a push (handleRefs) and a reconcile can carry the same ref concurrently, and
// both pass the seenHas check before either records — two stubs for one photo. The set closes
// that window; the loser returns false and the normal retry paths re-offer.
const inFlight = new Set<string>();
export async function materialiseRef(mapping, peer, ref) {
  if (seenHas(mapping.id, ref.checksum)) return true;
  const flightKey = `${mapping.id}:${ref.checksum}`;
  if (inFlight.has(flightKey)) return false;
  inFlight.add(flightKey);
  try {
    return await materialiseRefLocked(mapping, peer, ref);
  } finally {
    inFlight.delete(flightKey);
  }
}

async function materialiseRefLocked(mapping, peer, ref) {
  // Default is the hotlink model: nothing of the photo is stored, just a tiny stub the app can
  // render while every pixel streams live from the owner via the byte interceptors. When the admin
  // has turned on store-shared-locally, we instead keep the FULL original so the album survives the
  // owner going offline (oversize originals fall back to a stub — see MAX_FULL_BYTES).
  let bytes: Buffer;
  let ext = ref.kind === 'video' ? 'mp4' : 'jpg';
  let storedFull = false;
  const full = storeSharedAssetsLocally() ? await fetchFullOriginal(peer, ref, mapping.id) : null;
  if (full === 'retry') return false;
  if (full && full !== 'toobig') {
    bytes = full.bytes;
    ext = full.ext;
    storedFull = true;
  } else {
    if (full === 'toobig') log(`${ref.originAsset} is over the local-copy size cap — keeping a hotlink stub`);
    if (ref.kind === 'video') {
      // A playable 2MB prefix so the tile carries a real poster + duration; rest streams on demand.
      const pr = await peerByteRequest(
        peer,
        `/assets/${ref.originAsset}/playback`,
        'bytes=0-2097151',
        mapping.id
      );
      if (pr.status >= 400) {
        log(`playback stub fetch failed for ${ref.originAsset}: ${pr.status}`);
        return false;
      }
      // We ASKED for 2MB; a peer answering with the whole original must cost a failed ref, not our heap.
      const prefix: Buffer[] = [];
      let got = 0;
      for await (const chunk of recvIterable(pr.recv)) {
        got += chunk.length;
        if (got > 4 * 1024 * 1024) {
          log(`playback stub for ${ref.originAsset} ignored the range (>4MB) — deferring`);
          return false;
        }
        prefix.push(chunk);
      }
      bytes = Buffer.concat([...prefix, crypto.randomBytes(8)]);
    } else {
      // Size the stub to the origin's aspect ratio so Immich lays the mirror out correctly (grid tile
      // shape + viewer box); real pixels still stream via the interceptor. A ref from an older peer
      // carries no dimensions -> fall back to the legacy 1×1 stub. The random tail keeps each stub a
      // distinct asset (Immich dedupes identical bytes per user).
      const { width, height } = ref.exif ?? {};
      const base = width && height ? jpegOfSize(width, height) : STUB_JPEG;
      bytes = Buffer.concat([base, crypto.randomBytes(8)]);
    }
  }
  const hostKey = mapping.hostSlug ? state.contributors[mapping.hostSlug]?.apiKey : undefined;
  // On an INVITATION album a human already added the people they chose — their membership IS the
  // share. So for an invited person we must never add them: if they are missing, that absence is
  // the revocation, and filling it in would overrule the human and quietly re-create the share.
  // That, not a ledger, is what removes the revoke-versus-arriving-content race.
  //
  // Link-shared albums are the opposite: the link named a household, nobody named a person, so
  // attribution has no membership to inherit and the sidecar does have to create one.
  const contributorId = ref.contributor?.originUserId;
  const missingMemberMeansRevoked =
    mapping.via === 'invite' && !!contributorId && (mapping.forPeerUserIds || []).includes(contributorId);
  const c = await ensureContributor(
    ref.contributor?.displayName || peer.name,
    mapping.albumId,
    hostKey,
    peer,
    contributorId,
    mapping.peer,
    { reAddIfMissing: !missingMemberMeansRevoked }
  );
  // base64 checksums contain / and + — never let them into filenames
  const slug = ref.checksum.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  const up = await uploadAsset(bytes, `shared-${slug}.${ext}`, c.apiKey, ref.takenAt);
  await addToAlbum(mapping.albumId, [up.id], c.apiKey);
  await applyRefMetadata(up.id, ref, c.apiKey);
  seenAdd(mapping.id, ref.checksum, up.id, ref.originAsset, storedFull);
  log(
    `materialised ${storedFull ? 'full copy of' : 'stub for'} ref from ` +
      `"${ref.contributor?.displayName || peer.name}" into "${mapping.albumName}"`
  );
  return true;
}
// Delete a materialised proxy asset. Hard guard: only utility-owned assets are ever
// deleted — resolved via the owning contributor's own key. Human photos are untouchable.
export async function deleteProxyAsset(assetId: string): Promise<boolean> {
  try {
    let asset;
    try {
      asset = await immichJson(`/assets/${assetId}`);
    } catch (e) {
      if (/-> 404/.test(e.message)) return true;
      throw e;
    } // already gone
    const owner = Object.values(state.contributors).find(c => c.userId === asset.ownerId);
    if (!owner) {
      log(`proxy delete refused for ${assetId}: owner ${asset.ownerId} is not a utility user`);
      return false;
    }
    await immichJson(
      '/assets',
      { ...jsonBody({ ids: [assetId], force: true }), method: 'DELETE' },
      owner.apiKey
    );
    return true;
  } catch (e) {
    log(`proxy delete failed for ${assetId}: ${e.message}`);
    return false;
  }
}
