/**
 * state.ts — persistent state: the SQLite-backed store, this household's signing keypair,
 * and thin typed accessors over the seen-ledger / cache tables. Owns `save()`.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Store } from './store.ts';
import { CFG } from './config.ts';

fs.mkdirSync(CFG.dataDir, { recursive: true });
export const store = new Store(CFG.dataDir);
export const state = store.state;
/**
 * This household's signing keypair — the sidecar's whole identity on the wire.
 *
 * Exported non-null on purpose. `Store.state.keys` is legitimately nullable (nothing exists
 * before first boot), but it is generated here the moment this module loads and then persisted,
 * so every consumer downstream can rely on it. Reading `keys` rather than `state.keys` is what
 * keeps eleven call sites free of null checks that could never fire.
 */
function ensureKeys(): { pub: string; priv: string } {
  if (state.keys) return state.keys;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  state.keys = {
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
  return state.keys;
}
export const keys = ensureKeys();
export const save = () => store.save();
save();
export const seenHas = (mappingId: string, checksum: string) => store.seenHas(mappingId, checksum);
export const seenAdd = (mappingId: string, checksum: string, localAssetId: string, originAsset?: string) =>
  store.seenAdd(mappingId, checksum, localAssetId, originAsset);
// materialised proxies keep their SOURCE photo's checksum in the ledger — that identity,
// not the local file's checksum (a re-encoded preview), is what travels on the wire.
export const ledgerByAsset = (assetId: string) => store.ledgerByAsset(assetId);
export const wireChecksum = (a: { id: string; checksum: string }) => ledgerByAsset(a.id)?.c || a.checksum;
export const seenActHas = (id: string) => store.seenActHas(id);
export const seenActAdd = (id: string) => store.seenActAdd(id);
