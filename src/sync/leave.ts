/**
 * sync/leave.ts — undoing a join.
 *
 * Its own module because three different things now trigger it: the stock app's "Leave album"
 * (detected by the watcher), the panel's leave button, and an invitation being withdrawn
 * upstream. Keeping it here also breaks what would otherwise be a load-time import cycle
 * between engine.ts and invites.ts, which ARCHITECTURE.md's third convention forbids.
 */
import { log } from '../config.ts';
import { state, store, save } from '../state.ts';
import { readCredsFor, callAs } from '../immich/access.ts';
import { deleteProxyAsset } from '../immich/materialise.ts';
import { forgetOffered } from '../p2p/entitlement.ts';
import { peerRequest } from '../p2p/transport.ts';
import { forgetWatcherCycles } from './status.ts';

// Leave & purge: the reverse of joining. Removes every stub this album materialised
// (utility-owner-guarded), the mirror album, the mapping and its ledger — a join is
// fully reversible and reclaims all space it ever took, except for an asset another
// mapping still claims.
export async function leaveAlbum(mappingId: string) {
  const mapping = state.mappings.find(mp => mp.id === mappingId);
  if (!mapping || mapping.role !== 'member')
    throw new Error('unknown mapping (only joined albums can be left)');
  let removed = 0;
  for (const entry of store.seenForMapping(mapping.id)) {
    if (!entry.originAsset) continue;
    // A deduped proxy can carry ledger rows from several mappings, so another mapping may still
    // be serving this very asset. Ask the authoritative row (which holds the true wire identity)
    // rather than whether any row mentions the id — a stale row must never pin a stored copy.
    const owner = store.ledgerByAsset(entry.localAsset);
    if (owner && owner.mapping !== mapping.id) continue;
    if (await deleteProxyAsset(entry.localAsset)) removed++;
  }
  try {
    await callAs(readCredsFor(mapping), `/albums/${mapping.albumId}`, { method: 'DELETE' });
  } catch (e) {
    log(`mirror album delete failed: ${e.message}`);
  }
  forgetWatcherCycles(mapping.id);
  store.seenRemoveMapping(mapping.id);
  store.seenActRemoveMapping(mapping.id);
  forgetOffered(mapping.id);
  // Splice, never reassign. Loops run concurrently (watch, comments, invites), and replacing
  // the array silently discards anything another loop pushed onto the old reference in the
  // meantime — which lost freshly-created mirrors until this was found.
  const at = state.mappings.findIndex(mp => mp.id === mapping.id);
  if (at >= 0) state.mappings.splice(at, 1);
  save();
  // Courtesy signal so the origin stops pushing to a household that left. Best-effort and
  // unawaited: leaving must never block on the origin being reachable, and a peer too old
  // to know the route just 404s — the old one-sided behaviour.
  const origin = state.peers.find(p => p.pub === mapping.peer);
  const target = mapping.remoteMappingId || mapping.remoteAlbumId;
  if (origin && target)
    void peerRequest(origin, `/albums/${target}/leave`).catch(() => {
      /* unreachable or too old — their next 410 handling or manual unshare covers it */
    });
  log(`left "${mapping.albumName}" — ${removed} stub(s) purged`);
  return { left: mapping.albumName, purged: removed };
}
