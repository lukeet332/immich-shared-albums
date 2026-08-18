/**
 * sync/engine.ts — the reconciliation loops. watchOnce pushes local additions out to
 * peers; reconcileOnce/reconcileMapping pull the origin manifest, materialise missing
 * refs, and propagate deletions. leaveAlbum is the full reverse of a join. startWatchLoop
 * runs it all on an overlap-guarded interval.
 */
import { CFG, log } from '../config.ts';
import type { Mapping, Peer } from '../store.ts';
import { state, store, save, seenHas, seenAdd, wireChecksum } from '../state.ts';
import { sign, signedFetch } from '../peers.ts';
import { getAlbum, getAlbumAssets, usersById, immichJson } from '../immich/client.ts';
import { shareableAssets, assetToRef } from '../immich/refs.ts';
import { materialiseRef, deleteProxyAsset } from '../immich/materialise.ts';
import { recordOffered, forgetOffered } from '../p2p/entitlement.ts';

// Leave & purge: the reverse of joining. Removes every stub this album materialised
// (utility-owner-guarded), the mirror album, the mapping and its ledger — a join is
// fully reversible and reclaims all space it ever took.
export async function leaveAlbum(mappingId: string) {
  const mapping = state.mappings.find(mp => mp.id === mappingId);
  if (!mapping || mapping.role !== 'member') throw new Error('unknown mapping (only joined albums can be left)');
  let removed = 0;
  for (const entry of store.seenForMapping(mapping.id)) {
    if (entry.o && await deleteProxyAsset(entry.l)) removed++;
  }
  const host = mapping.adminSlug ? state.contributors[mapping.adminSlug] : undefined;
  if (host?.key) {
    try { await immichJson(`/albums/${mapping.albumId}`, { method: 'DELETE' }, host.key); }
    catch (e) { log(`mirror album delete failed: ${e.message}`); }
  }
  store.seenRemoveMapping(mapping.id);
  forgetOffered(mapping.id);
  state.mappings = state.mappings.filter(mp => mp.id !== mapping.id);
  save();
  log(`left "${mapping.albumName}" — ${removed} stub(s) purged`);
  return { left: mapping.albumName, purged: removed };
}
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
        const humans = (album.albumUsers || []).filter((au) => {
          const u = users[au.user?.id]; return u && !u.utility;
        });
        if (humans.length === 0) { await leaveAlbum(mapping.id); continue; }
      }
      if (mapping.role === 'member' && mapping.permissions === 'view') continue; // view-only: nothing to push
      const assets = await getAlbumAssets(mapping.albumId);
      mapping.failCount = 0;
      const fresh = await shareableAssets(assets, mapping.id);
      if (!fresh.length) { mapping.localVersion = album.updatedAt; save(); continue; }
      const peer = state.peers.find(p => p.pub === mapping.peer);
      const targetMapping = mapping.role === 'member' ? (mapping.remoteMappingId || mapping.remoteAlbumId) : mapping.albumId;
      const add = [];
      for (const a of fresh) add.push(await assetToRef(a));
      const body = JSON.stringify({ add });
      const r = await signedFetch(`${peer.url}/sidecar/api/v1/albums/${targetMapping}/refs`, body);
      if (r.ok) {
        const failed = new Set((await r.json().catch(() => ({}))).failed || []);
        const landed = fresh.filter(a => !failed.has(wireChecksum(a)));
        landed.forEach(a => seenAdd(mapping.id, wireChecksum(a), a.id));
        // pushed to this peer => this peer may read their bytes (see p2p/entitlement)
        recordOffered(mapping.id, landed.map(a => a.id));
        if (!failed.size) { mapping.localVersion = album.updatedAt; save(); }
        log(`pushed ${landed.length}/${fresh.length} ref(s) to "${peer.name}"${failed.size ? ` (${failed.size} deferred)` : ''}`);
      } else log(`ref push failed: ${r.status}`);
    } catch (e) {
      mapping.failCount = (mapping.failCount || 0) + 1;
      if (/album.read access|Not found/i.test(e.message) && mapping.failCount >= 5) {
        mapping.dead = true; save();
        log(`mapping "${mapping.albumName}" marked dead after ${mapping.failCount} failures (album deleted?) — no longer polled`);
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
    } catch (e) { log(`reconcile error on "${mapping.albumName}": ${e.message}`); }
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
      const sig = { headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(target) } };
      // handshake first: only pull the full manifest when the origin's version moved.
      // remoteVersion is only stored after a CLEAN pass so failures keep retrying.
      let version = null;
      const vr = await fetch(`${peer.url}/sidecar/api/v1/albums/${target}/version`, { ...sig, signal: AbortSignal.timeout(15000) });
      if (vr.ok) {
        version = (await vr.json().catch(() => ({}))).version || null;
        if (version && version === mapping.remoteVersion) return;
      }
      const r = await fetch(`${peer.url}/sidecar/api/v1/albums/${target}/manifest`, { ...sig, signal: AbortSignal.timeout(30000) });
      if (!r.ok) return;
      const { manifest = [] } = await r.json();
      // The version's asset count comes from the album table (instant); the manifest
      // comes from the search index (which lags behind deletes). Only trust a read
      // where the two agree — dirty reads retry next cycle instead of poisoning the cursor.
      const expectedCount = version ? Number(String(version).split('|')[1]) : NaN;
      const consistent = !Number.isFinite(expectedCount) || manifest.length === expectedCount;
      if (process.env.RECONCILE_DEBUG) log(`DBG reconcile "${mapping.albumName}": version=${version} cursor=${mapping.remoteVersion} manifest=${manifest.length} expected=${expectedCount} consistent=${consistent} ledger=${store.seenForMapping(mapping.id).length}`);
      // deletion propagation: refs we materialised that the owner no longer offers are
      // gone at the source — remove our stubs too (utility-owner-guarded).
      let propagated = true;
      if (version && consistent) {
        const offered = new Set(manifest.map((x) => x.checksum));
        for (const entry of store.seenForMapping(mapping.id)) {
          if (process.env.RECONCILE_DEBUG) log(`DBG entry c=${entry.c.slice(0,8)} o=${!!entry.o} offered=${offered.has(entry.c)}`);
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
        try { if (await materialiseRef(mapping, peer.url, peer.name, ref)) log(`reconciled missed ref into "${mapping.albumName}"`); else allOk = false; }
        catch (e) { allOk = false; log(`reconcile materialise failed (${ref.checksum?.slice(0,10)}): ${e.message}`); }
      }
      if (allOk && propagated && version && consistent) { mapping.remoteVersion = version; save(); }
  } finally { RECONCILING.delete(mapping.id); }
}

// overlap guard: a slow cycle (large albums, slow peers) must not stack concurrent
// full scans — stampedes starve the host Immich's own background jobs.
let WATCH_RUNNING = false;
export function startWatchLoop() {
  setInterval(() => {
    if (WATCH_RUNNING) return;
    WATCH_RUNNING = true;
    watchOnce().catch(e => log('watch loop:', e.message)).finally(() => { WATCH_RUNNING = false; });
  }, CFG.pollMs);
}
