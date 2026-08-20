/** state.ts — persistent state: the SQLite-backed store, this household's signing keypair,. See store.md. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Store } from './store.ts';
import { CFG } from './config.ts';

fs.mkdirSync(CFG.dataDir, { recursive: true });
export const store = new Store(CFG.dataDir);
export const state = store.state;
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
export const ledgerByAsset = (assetId: string) => store.ledgerByAsset(assetId);
export const wireChecksum = (a: { id: string; checksum: string }) => ledgerByAsset(a.id)?.c || a.checksum;
export const addedRecord = (albumId: string, userId: string) => store.addedRecord(albumId, userId);
export const addedHas = (albumId: string, userId: string) => store.addedHas(albumId, userId);
export const addedForget = (albumId: string, userId: string) => store.addedForget(albumId, userId);
export const seenActHas = (id: string) => store.seenActHas(id);
export const seenActAdd = (id: string) => store.seenActAdd(id);
