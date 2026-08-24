/**
 * sync/engine.ts — the reconciliation loops. watchOnce pushes local additions out to
 * peers; reconcileOnce/reconcileMapping pull the origin manifest, materialise missing
 * refs, and propagate deletions. leaveAlbum is the full reverse of a join. startWatchLoop
 * runs it all on an overlap-guarded interval.
 */
import type { AssetRef } from '../types.ts';
import { CFG, log } from '../config.ts';
import type { Mapping, Peer } from '../store.ts';
import { state, store, save, seenHas, seenAdd, wireChecksum } from '../state.ts';
import { peerRequest } from '../p2p/transport.ts';
import { getAlbum, getAlbumAssets, usersById } from '../immich/client.ts';
import { shareableAssets, assetToRef } from '../immich/refs.ts';
import { materialiseRef, deleteProxyAsset } from '../immich/materialise.ts';
import { recordOffered } from '../p2p/entitlement.ts';
import { leaveAlbum } from './leave.ts';

export async function watchOnce() {
  for (const mapping of state.mappings) {
    if (mapping.dead) continue;

    try {
      // handshake: skip untouched albums entirely (updatedAt bumps on any album change).
      // localVersion is only stored after a CLEAN cycle so deferred refs keep re-offering.
      const album = await getAlbum(mapping.albumId);
      if (album.updatedAt && album.updatedAt === mapping.localVersion) continue;
      // native leave: when the last human member leaves the mirror in the STOCK app
      // (album settings -> Leave album), the sidecar cleans up everything the join
      // created — stubs, mirror, mapping, ledger. No custom UI involved.
      if (mapping.role === 'member') {
        const users = await usersById();
        const humans = (album.albumUsers || []).filter(au => {
          const u = users[au.user?.id];
          return u && !u.utility;
        });
        if (humans.length === 0) {
          await leaveAlbum(mapping.id);
          continue;
        }
      }
      if (mapping.role === 'member' && mapping.permissions === 'view') continue; // view-only: nothing to push
      const assets = await getAlbumAssets(mapping.albumId);
      mapping.failCount = 0;
      // Revocation, per photo: an asset removed from the album must stop being served to
      // this mapping's peer, not just stop being advertised.
      const revoked = store.offeredReconcile(
        mapping.id,
        assets.map(a => a.id)
      );
      if (revoked) log(`revoked ${revoked} byte entitlement(s) on "${mapping.albumName}"`);
      const fresh = await shareableAssets(assets, mapping.id);
      if (!fresh.length) {
        mapping.localVersion = album.updatedAt;
        save();
        continue;
      }
      const peer = state.peers.find(p => p.pub === mapping.peer);
      if (!peer) continue; // no peer record: nothing to push to
      const targetMapping =
        mapping.role === 'member' ? mapping.remoteMappingId || mapping.remoteAlbumId : mapping.albumId;
      const add: AssetRef[] = [];
      for (const a of fresh) add.push(await assetToRef(a));
      // Offering IS the grant: the peer materialises DURING the push, fetching stub bytes
      // back from us before any response lands — so entitlement must be recorded first.
      // A failed push leaves rows for assets still in the album, which the reconcile above
      // keeps honest.
      recordOffered(
        mapping.id,
        fresh.map(a => a.id)
      );
      const r = await peerRequest(peer, `/albums/${targetMapping}/refs`, { add });
      if (r.status < 400) {
        const failed = new Set(r.json?.failed || []);
        const landed = fresh.filter(a => !failed.has(wireChecksum(a)));
        landed.forEach(a => seenAdd(mapping.id, wireChecksum(a), a.id));
        if (!failed.size) {
          mapping.localVersion = album.updatedAt;
          save();
        }
        log(
          `pushed ${landed.length}/${fresh.length} ref(s) to "${peer.name}"${failed.size ? ` (${failed.size} deferred)` : ''}`
        );
      } else log(`ref push failed: ${r.status}`);
    } catch (e) {
      mapping.failCount = (mapping.failCount || 0) + 1;
      if (/album.read access|Not found/i.test(e.message) && mapping.failCount >= 5) {
        mapping.dead = true;
        mapping.deadAt = new Date().toISOString();
        mapping.deadReason = `watcher: ${e.message.slice(0, 120)}`;
        save();
        log(
          `mapping "${mapping.albumName}" marked dead after ${mapping.failCount} failures (album deleted?) — no longer polled`
        );
      } else log(`watcher error on "${mapping.albumName}": ${e.message}`);
    }
  }
  await reconcileOnce();
}
// Heal member mirrors: re-pull the origin manifest and materialise anything we
// missed (e.g. previews not yet generated at join time). Cheap no-op when in sync.
export async function reconcileOnce() {
  for (const mapping of state.mappings.filter(mp => mp.role === 'member' && !mp.dead)) {
    try {
      const peer = state.peers.find(p => p.pub === mapping.peer);
      if (!peer) continue;
      await reconcileMapping(mapping, peer);
    } catch (e) {
      log(`reconcile error on "${mapping.albumName}": ${e.message}`);
    }
  }
}
// per-mapping mutex: the join-time reconcile is fired unawaited and can race the
// interval loop — both would materialise the same "missing" refs (stubs are unique
// bytes, so Immich cannot dedup the collision into one asset).
export const RECONCILING = new Set<string>();
export async function reconcileMapping(mapping: Mapping, peer: Peer) {
  if (RECONCILING.has(mapping.id)) return;
  RECONCILING.add(mapping.id);
  try {
    const target = mapping.remoteMappingId || mapping.remoteAlbumId;
    // handshake first: only pull the full manifest when the origin's version moved.
    // remoteVersion is only stored after a CLEAN pass so failures keep retrying.
    let version = null;
    const vr = await peerRequest(peer, `/albums/${target}/version`).catch(() => null);
    if (vr && vr.status < 400) {
      version = vr.json?.version || null;
      if (version && version === mapping.remoteVersion) return;
    }
    const r = await peerRequest(peer, `/albums/${target}/manifest`).catch(() => null);
    if (!r || r.status >= 400) return;
    const { manifest = [] } = r.json ?? {};
    // The version's asset count comes from the album table (instant); the manifest
    // comes from the search index (which lags behind deletes). Only trust a read
    // where the two agree — dirty reads retry next cycle instead of poisoning the cursor.
    const expectedCount = version ? Number(String(version).split('|')[1]) : NaN;
    const consistent = !Number.isFinite(expectedCount) || manifest.length === expectedCount;
    if (process.env.RECONCILE_DEBUG)
      log(
        `DBG reconcile "${mapping.albumName}": version=${version} cursor=${mapping.remoteVersion} manifest=${manifest.length} expected=${expectedCount} consistent=${consistent} ledger=${store.seenForMapping(mapping.id).length}`
      );
    // deletion propagation: refs we materialised that the owner no longer offers are
    // gone at the source — remove our stubs too (utility-owner-guarded).
    let propagated = true;
    if (version && consistent) {
      const offered = new Set(manifest.map(x => x.checksum));
      for (const entry of store.seenForMapping(mapping.id)) {
        if (process.env.RECONCILE_DEBUG)
          log(
            `DBG entry c=${entry.checksum.slice(0, 8)} o=${!!entry.originAsset} offered=${offered.has(entry.checksum)}`
          );
        if (!entry.originAsset || offered.has(entry.checksum)) continue;
        if (await deleteProxyAsset(entry.localAsset)) {
          store.seenRemoveEntry(mapping.id, entry.checksum);
          log(`removed stub for a photo its owner deleted ("${mapping.albumName}")`);
        } else propagated = false; // keep the cursor back so the removal retries next cycle
      }
    }
    const missing = manifest.filter(ref => !seenHas(mapping.id, ref.checksum));
    let allOk = true;
    for (const ref of missing) {
      try {
        if (await materialiseRef(mapping, peer, ref))
          log(`reconciled missed ref into "${mapping.albumName}"`);
        else allOk = false;
      } catch (e) {
        allOk = false;
        log(`reconcile materialise failed (${ref.checksum?.slice(0, 10)}): ${e.message}`);
      }
    }
    if (allOk && propagated && version && consistent) {
      mapping.remoteVersion = version;
      save();
    }
  } finally {
    RECONCILING.delete(mapping.id);
  }
}

// overlap guard: a slow cycle (large albums, slow peers) must not stack concurrent
// full scans — stampedes starve the host Immich's own background jobs.
let WATCH_RUNNING = false;
export function startWatchLoop() {
  setInterval(() => {
    if (WATCH_RUNNING) return;
    WATCH_RUNNING = true;
    watchOnce()
      .catch(e => log('watch loop:', e.message))
      .finally(() => {
        WATCH_RUNNING = false;
      });
  }, CFG.pollMs);
}
