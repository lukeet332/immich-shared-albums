/**
 * media/cache.ts — a bounded LRU byte-cache for streamed previews. Files live under
 * <dataDir>/cache with accounting in SQLite; a cache, not storage (capped, reclaimable,
 * safe to delete). Disabled when CACHE_MAX_MB=0.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { CFG, log } from '../config.ts';
import { store } from '../state.ts';

export const CACHE_DIR = `${CFG.dataDir}/cache`;
fs.mkdirSync(CACHE_DIR, { recursive: true });
export const cacheKey = (originAsset: string) => crypto.createHash('sha1').update(originAsset).digest('hex');
export function cacheRead(originAsset: string): Buffer | null {
  if (!CFG.cacheMaxMb) return null;
  const key = cacheKey(originAsset);
  if (!store.cacheTouch(key)) return null;
  try {
    return fs.readFileSync(`${CACHE_DIR}/${key}`);
  } catch {
    return null;
  } // index said yes, disk said no — self-heals on next put
}
export function cacheWrite(originAsset: string, bytes: Buffer) {
  if (!CFG.cacheMaxMb || bytes.length > (CFG.cacheMaxMb * 1024 * 1024) / 10) return; // no single item >10% of cap
  const key = cacheKey(originAsset);
  try {
    fs.writeFileSync(`${CACHE_DIR}/${key}`, bytes);
    store.cachePut(key, bytes.length);
    while (store.cacheTotal() > CFG.cacheMaxMb * 1024 * 1024) {
      const evicted = store.cacheEvictOldest();
      if (!evicted) break;
      try {
        fs.unlinkSync(`${CACHE_DIR}/${evicted.key}`);
      } catch {
        /* already gone */
      }
    }
  } catch (e) {
    log(`cache write skipped: ${e.message}`);
  }
}
