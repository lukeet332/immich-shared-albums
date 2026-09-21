/** sync/peer-mapping-id.ts — the id a peer addresses the album behind a mapping by. See sync-loops.md. */

import type { Mapping } from '../store.ts';

/** What a peer's routes mean when they name this mapping's album (`/albums/:id/refs`, `/comments`).
 *
 *  Two different ids answer to that name, and which one is right depends on which side owns the
 *  album. A mirror WE hold is addressed by the id the origin minted for it — `remoteMappingId`, the
 *  origin's own mapping, and `remoteAlbumId` for a protocol-2 peer that predates it. Our OWN album
 *  is addressed by our album id: this mapping may carry the peer's mirror ids too, and naming our
 *  album with one of those would write to a mapping that is not ours.
 *
 *  Empty when a member mirror has neither remote id: a caller must refuse rather than guess, because
 *  every guess here addresses an album nobody offered.
 */
export function peerAlbumMappingId(
  mapping: Pick<Mapping, 'role' | 'albumId' | 'remoteMappingId' | 'remoteAlbumId'>
): string {
  return mapping.role === 'member' ? mapping.remoteMappingId || mapping.remoteAlbumId || '' : mapping.albumId;
}
