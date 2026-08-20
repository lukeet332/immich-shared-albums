/**
 * media/interceptor.ts — the app-facing byte interceptor. The stock Immich app requests
 * its own asset URLs (/api/assets/:id/{thumbnail,original,video/playback}); for a proxy
 * asset we serve the true bytes live from the owner's server (previews via the bounded LRU
 * cache), falling through to Immich — which holds only a stub — on any failure (fail-open).
 * Returns true iff it wrote the response; false tells the router to fall through.
 */
import { Readable } from 'node:stream';
import { CFG, log, ROUTE_PREFIX } from '../config.ts';
import { state, store } from '../state.ts';
import { sign } from '../peers.ts';
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
        const up = await fetch(`${peer2.url}${ROUTE_PREFIX}/api/v1/assets/${entry.o}/preview`, {
          headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(entry.o) },
          signal: AbortSignal.timeout(30000),
        });
        if (up.ok) {
          const buf = Buffer.from(await up.arrayBuffer());
          cacheWrite(entry.o, buf);
          res.writeHead(200, {
            ...baseHeaders,
            'Content-Type': up.headers.get('content-type') || 'image/jpeg',
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
    if (!Array.isArray(out)) {
      const headers: Record<string, string> = {
        'Content-Type': out.headers.get('content-type') || 'application/octet-stream',
        // per-asset bytes never change: let every device cache them hard
        'Cache-Control': 'private, max-age=604800, immutable',
      };
      for (const h of ['content-length', 'content-range', 'accept-ranges']) {
        const v = out.headers.get(h);
        if (v) headers[h] = v;
      }
      res.writeHead(out.status || 200, headers);
      Readable.fromWeb(out.body).pipe(res);
      return true;
    }
  } catch (e) {
    log(`byte interceptor fell through (${kind}): ${e.message}`);
  }
  return false; // entry existed but we fell through -> Immich serves what it has
}
