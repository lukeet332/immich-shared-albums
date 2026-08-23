/**
 * media/interceptor.ts — the app-facing byte interceptor. The stock Immich app requests
 * its own asset URLs (/api/assets/:id/{thumbnail,original,video/playback}); for a proxy
 * asset we serve the true bytes live from the owner's server (previews via the bounded LRU
 * cache), falling through to Immich — which holds only a stub — on any failure (fail-open).
 * Returns true iff it wrote the response; false tells the router to fall through.
 */
import { CFG, log } from '../config.ts';
import { state, store } from '../state.ts';
import { peerByteRequest, recvIterable } from '../p2p/transport.ts';
import { immich } from '../immich/client.ts';
import { fetchTrueBytes } from './proxy.ts';
import { cacheRead, cacheWrite } from './cache.ts';

export async function serveInterceptedBytes(req, res, assetId: string, rawKind: string): Promise<boolean> {
  const kind = rawKind === 'thumbnail' ? 'preview' : rawKind === 'original' ? 'original' : 'playback';
  const entry = store.ledgerWithOrigin(assetId);
  if (!entry) return false; // not a proxy asset -> Immich serves it
  // authorise with the caller's OWN credentials: they must be able to see the asset
  const authHeaders: Record<string, string> = {};
  for (const h of ['cookie', 'x-api-key', 'authorization'])
    if (req.headers[h]) authHeaders[h] = req.headers[h] as string;
  const probe = await fetch(`${CFG.immichUrl}/api/assets/${assetId}`, { headers: authHeaders });
  if (!probe.ok) {
    res.writeHead(probe.status);
    res.end();
    return true;
  }
  // previews ride the bounded LRU cache: household-wide repeat views skip the
  // cross-server fetch, and recently viewed photos survive owner downtime.
  // Only bytes that truly came FROM THE PEER are ever cached (a local stub
  // fallback must not poison the cache), and hits refresh their LRU slot.
  if (kind === 'preview') {
    const cached = cacheRead(entry.o);
    const baseHeaders = {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=604800, immutable',
    };
    if (cached) {
      res.writeHead(200, { ...baseHeaders, 'X-Cache': 'HIT', 'Content-Length': String(cached.length) });
      res.end(cached);
      return true;
    }
    const mapping2 = state.mappings.find(mp => mp.id === entry.m);
    const peer2 = mapping2 && state.peers.find(pe => pe.pub === mapping2.peer);
    if (peer2) {
      try {
        const up = await peerByteRequest(peer2, `/assets/${entry.o}/preview`);
        if (up.status < 400) {
          const chunks: Buffer[] = [];
          for await (const chunk of recvIterable(up.recv)) chunks.push(chunk);
          const buf = Buffer.concat(chunks);
          cacheWrite(entry.o, buf);
          res.writeHead(200, {
            ...baseHeaders,
            'Content-Type': up.headers['content-type'] || 'image/jpeg',
            'X-Cache': 'MISS',
            'Content-Length': String(buf.length),
          });
          res.end(buf);
          return true;
        }
      } catch (e) {
        log(`preview fetch failed, serving stub: ${e.message}`);
      }
    }
    // owner unreachable and nothing cached -> the local stub thumbnail (uncached)
    const stub = await immich(`/assets/${assetId}/thumbnail?size=preview`).catch(() => null);
    if (stub) {
      res.writeHead(200, {
        ...baseHeaders,
        'Content-Type': stub.headers.get('content-type') || 'image/jpeg',
        'X-Cache': 'BYPASS',
      });
      res.end(Buffer.from(await stub.arrayBuffer()));
      return true;
    }
    res.writeHead(503);
    res.end();
    return true;
  }
  try {
    const out = await fetchTrueBytes(assetId, kind, req.headers.range as string | undefined);
    const headers: Record<string, string> = {
      ...out.headers,
      'Content-Type': out.headers['content-type'] || 'application/octet-stream',
      // per-asset bytes never change: let every device cache them hard
      'Cache-Control': 'private, max-age=604800, immutable',
    };
    res.writeHead(out.status || 200, headers);
    for await (const chunk of out.body) res.write(chunk);
    res.end();
    return true;
  } catch (e) {
    log(`byte interceptor fell through (${kind}): ${e.message}`);
  }
  return false; // entry existed but we fell through -> Immich serves what it has
}
