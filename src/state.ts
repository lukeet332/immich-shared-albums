/**
 * state.ts — persistent state: the SQLite-backed store, this household's transport identity,
 * and thin typed accessors over the seen-ledger / cache tables. Owns `save()`.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Store, type Identity } from './store.ts';
import { CFG } from './config.ts';

// 0700: this directory holds the identity key and every bot account's API key.
fs.mkdirSync(CFG.dataDir, { recursive: true, mode: 0o700 });
// The identity key IS this server's identity: lose the volume and every pairing dies with it.
// A data dir on the container's own filesystem (or an anonymous volume) survives restarts but
// not recreation — loud warning rather than silent data loss on the next `down`.
try {
  const { dev: dataDev } = fs.statSync(CFG.dataDir);
  const { dev: rootDev } = fs.statSync('/');
  if (dataDev === rootDev)
    console.error(
      `WARNING: ${CFG.dataDir} is not a mounted volume — this server's identity will be lost when the container is recreated. Bind-mount it (see deploy/docker-compose.example.yml).`
    );
} catch {
  /* stat quirks on exotic filesystems must not stop boot */
}
export const store = new Store(CFG.dataDir);
export const state = store.state;
/**
 * This household's transport identity — the sidecar's whole identity on the wire.
 *
 * Stored RAW (32 bytes each side, base64url): `pub` is byte-for-byte the iroh endpoint id,
 * so the boot log, the database, every ticket and every peer's record all show the same
 * string. The DER envelopes the signing era needed are gone with it.
 *
 * Exported non-null on purpose. `Store.state.identity` is legitimately nullable (nothing
 * exists before first boot), but it is generated here the moment this module loads and then
 * persisted, so every consumer downstream can rely on it.
 */
function ensureIdentity(): Identity {
  if (state.identity) return state.identity;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const priv = (privateKey.export({ format: 'jwk' }) as { d: string }).d;
  state.identity = { v: 1, alg: 'ed25519', pub, priv, createdAt: new Date().toISOString() };
  return state.identity;
}
export const keys = ensureIdentity();
export const save = () => store.save();
save();
export const seenHas = (mappingId: string, checksum: string) => store.seenHas(mappingId, checksum);
export const seenAdd = (mappingId: string, checksum: string, localAssetId: string, originAsset?: string) =>
  store.seenAdd(mappingId, checksum, localAssetId, originAsset);
// materialised proxies keep their SOURCE photo's checksum in the ledger — that identity,
// not the local file's checksum (a re-encoded preview), is what travels on the wire.
export const ledgerByAsset = (assetId: string) => store.ledgerByAsset(assetId);
export const wireChecksum = (a: { id: string; checksum: string }) =>
  ledgerByAsset(a.id)?.checksum || a.checksum;
// Memberships this sidecar created, as opposed to ones a human made. See store.addedRecord —
// the write order is a security property, not a style choice.
export const addedRecord = (albumId: string, userId: string) => store.addedRecord(albumId, userId);
export const addedHas = (albumId: string, userId: string) => store.addedHas(albumId, userId);
export const addedForget = (albumId: string, userId: string) => store.addedForget(albumId, userId);
export const seenActHas = (tag: string) => store.seenActHas(tag);
export const seenActAdd = (tag: string, mappingId: string) => store.seenActAdd(tag, mappingId);
