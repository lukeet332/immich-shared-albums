/** sync/engine.ts — the push and reconcile loops. See sync-loops.md. */
import type { AssetRef } from '../types.ts';
import { CFG, log, ROUTE_PREFIX } from '../config.ts';
import type { Mapping, Peer } from '../store.ts';
import { state, store, save, seenHas, seenAdd, wireChecksum, keys } from '../state.ts';
import { sign, signedFetch } from '../peers.ts';
import { getAlbum, getAlbumAssets, usersById } from '../immich/client.ts';
import { notYetSentTo, assetToRef } from '../immich/refs.ts';
import { tryMaterialiseRef, deleteProxyAsset } from '../immich/materialise.ts';
import { recordOffered } from '../p2p/entitlement.ts';
import { leaveAlbum } from './leave.ts';

export async function watchOnce() {
  for (const mapping of state.mappings) {
    if (mapping.dead) continue;

    try {
      const album = await getAlbum(mapping.albumId);
      if (album.updatedAt && album.updatedAt === mapping.localVersion) continue;
      if (mapping.role === 'member') {
        const users = await usersById();
        const humans = (album.albumUsers || []).filter(au => {
          const member = users[au.user?.id];
          return member && !member.utility;
        });
        if (humans.length === 0) {
          await leaveAlbum(mapping.id);
          continue;
        }
      }
      if (mapping.role === 'member' && mapping.permissions === 'view') continue;
      const assets = await getAlbumAssets(mapping.albumId);
      mapping.failCount = 0;
      const fresh = await notYetSentTo(assets, mapping.id);
      if (!fresh.length) {
        mapping.localVersion = album.updatedAt;
        save();
        continue;
      }
      const peer = state.peers.find(p => p.pub === mapping.peer);
      if (!peer) continue;
      const targetMapping =
        mapping.role === 'member' ? mapping.remoteMappingId || mapping.remoteAlbumId : mapping.albumId;
      const add: AssetRef[] = [];
      for (const a of fresh) add.push(await assetToRef(a));
      const body = JSON.stringify({ add });
      const pushResponse = await signedFetch(
        `${peer.url}${ROUTE_PREFIX}/api/v1/albums/${targetMapping}/refs`,
        body
      );
      if (pushResponse.ok) {
        const failed = new Set((await pushResponse.json().catch(() => ({}))).failed || []);
        const landed = fresh.filter(a => !failed.has(wireChecksum(a)));
        landed.forEach(a => seenAdd(mapping.id, wireChecksum(a), a.id));
        recordOffered(
          mapping.id,
          landed.map(a => a.id)
        );
        if (!failed.size) {
          mapping.localVersion = album.updatedAt;
          save();
        }
        log(
          `pushed ${landed.length}/${fresh.length} ref(s) to "${peer.name}"${failed.size ? ` (${failed.size} deferred)` : ''}`
        );
      } else log(`ref push failed: ${pushResponse.status}`);
    } catch (e) {
      mapping.failCount = (mapping.failCount || 0) + 1;
      if (/album.read access|Not found/i.test(e.message) && mapping.failCount >= 5) {
        mapping.dead = true;
        save();
        log(
          `mapping "${mapping.albumName}" marked dead after ${mapping.failCount} failures (album deleted?) — no longer polled`
        );
      } else log(`watcher error on "${mapping.albumName}": ${e.message}`);
    }
  }
  await reconcileOnce();
}
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
export const RECONCILING = new Set<string>();
export async function reconcileMapping(mapping: Mapping, peer: Peer) {
  if (RECONCILING.has(mapping.id)) return;
  RECONCILING.add(mapping.id);
  try {
    const target = mapping.remoteMappingId || mapping.remoteAlbumId;
    const sig = { headers: { 'x-isa-key': keys.pub, 'x-isa-sig': sign(target) } };
    let version = null;
    const versionResponse = await fetch(`${peer.url}${ROUTE_PREFIX}/api/v1/albums/${target}/version`, {
      ...sig,
      signal: AbortSignal.timeout(15000),
    });
    if (versionResponse.ok) {
      version = (await versionResponse.json().catch(() => ({}))).version || null;
      if (version && version === mapping.remoteVersion) return;
    }
    const manifestResponse = await fetch(`${peer.url}${ROUTE_PREFIX}/api/v1/albums/${target}/manifest`, {
      ...sig,
      signal: AbortSignal.timeout(30000),
    });
    if (!manifestResponse.ok) return;
    const { manifest = [] } = await manifestResponse.json();
    const expectedCount = version ? Number(String(version).split('|')[1]) : NaN;
    const consistent = !Number.isFinite(expectedCount) || manifest.length === expectedCount;
    if (process.env.RECONCILE_DEBUG)
      log(
        `DBG reconcile "${mapping.albumName}": version=${version} cursor=${mapping.remoteVersion} manifest=${manifest.length} expected=${expectedCount} consistent=${consistent} ledger=${store.seenForMapping(mapping.id).length}`
      );
    let propagated = true;
    if (version && consistent) {
      const offered = new Set(manifest.map(x => x.checksum));
      for (const entry of store.seenForMapping(mapping.id)) {
        if (process.env.RECONCILE_DEBUG)
          log(`DBG entry c=${entry.c.slice(0, 8)} o=${!!entry.o} offered=${offered.has(entry.c)}`);
        if (!entry.o || offered.has(entry.c)) continue;
        if (await deleteProxyAsset(entry.l)) {
          store.seenRemoveEntry(mapping.id, entry.c);
          log(`removed stub for a photo its owner deleted ("${mapping.albumName}")`);
        } else propagated = false; // keep the cursor back so the removal retries next cycle
      }
    }
    const missing = manifest.filter(ref => !seenHas(mapping.id, ref.checksum));
    let allOk = true;
    for (const ref of missing) {
      try {
        if (await tryMaterialiseRef(mapping, peer.url, peer.name, ref))
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

let watchCycleInFlight = false;
export function startWatchLoop() {
  setInterval(() => {
    if (watchCycleInFlight) return;
    watchCycleInFlight = true;
    watchOnce()
      .catch(e => log('watch loop:', e.message))
      .finally(() => {
        watchCycleInFlight = false;
      });
  }, CFG.pollMs);
}
