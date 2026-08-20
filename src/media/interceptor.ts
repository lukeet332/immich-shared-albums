/** media/interceptor.ts — serves true bytes on Immich's own asset URLs. See hotlink-bytes.md. */
import { Readable } from 'node:stream';
import { CFG, log, ROUTE_PREFIX } from '../config.ts';
import { state, store, keys } from '../state.ts';
import { sign } from '../peers.ts';
import { immich } from '../immich/client.ts';
import { fetchTrueBytes } from './proxy.ts';
import { cacheRead, cacheWrite } from './cache.ts';

export async function serveInterceptedBytes(req, res, assetId: string, rawKind: string): Promise<boolean> {
  const kind = rawKind === 'thumbnail' ? 'preview' : rawKind === 'original' ? 'original' : 'playback';
  const entry = store.ledgerWithOrigin(assetId);
  if (!entry) return false; // not a proxy asset -> Immich serves it
  const authHeaders: Record<string, string> = {};
  for (const h of ['cookie', 'x-api-key', 'authorization'])
    if (req.headers[h]) authHeaders[h] = req.headers[h] as string;
  const probe = await fetch(`${CFG.immichUrl}/api/assets/${assetId}`, { headers: authHeaders });
  if (!probe.ok) {
    res.writeHead(probe.status);
    res.end();
    return true;
  }
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
        const ownerResponse = await fetch(`${peer2.url}${ROUTE_PREFIX}/api/v1/assets/${entry.o}/preview`, {
          headers: { 'x-isa-key': keys.pub, 'x-isa-sig': sign(entry.o) },
          signal: AbortSignal.timeout(30000),
        });
        if (ownerResponse.ok) {
          const bytes = Buffer.from(await ownerResponse.arrayBuffer());
          cacheWrite(entry.o, bytes);
          res.writeHead(200, {
            ...baseHeaders,
            'Content-Type': ownerResponse.headers.get('content-type') || 'image/jpeg',
            'X-Cache': 'MISS',
            'Content-Length': String(bytes.length),
          });
          res.end(bytes);
          return true;
        }
      } catch (e) {
        log(`preview fetch failed, serving stub: ${e.message}`);
      }
    }
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
        'Cache-Control': 'private, max-age=604800, immutable',
      };
      for (const h of ['content-length', 'content-range', 'accept-ranges']) {
        const value = out.headers.get(h);
        if (value) headers[h] = value;
      }
      res.writeHead(out.status || 200, headers);
      Readable.fromWeb(out.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
      return true;
    }
  } catch (e) {
    log(`byte interceptor fell through (${kind}): ${e.message}`);
  }
  return false; // entry existed but we fell through -> Immich serves what it has
}
