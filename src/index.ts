/**
 * immich-shared-albums — entry point / composition root.
 * One process: an HTTP server (protocol + panel + byte proxies) plus two sync loops.
 * State is SQLite via node:sqlite (see store.ts). TypeScript is run natively by Node's
 * type stripping — no build step. Node >= 23.6, zero dependencies.
 *
 * The code is split by concern — see each folder's .md:
 *   config.ts / state.ts / peers.ts   core: settings, persistence, P2P signing
 *   immich/                           local Immich API, refs, contributors, proxy writes
 *   p2p/                              wire protocol + join
 *   sync/                             reconcile + comment loops
 *   media/                            hotlink byte path + LRU cache
 *   web/                              HTML pages + HTTP router
 */
import { CFG, log } from './config.ts';
import { server } from './web/server.ts';
import { proxyUpgrade } from './web/upgrade.ts';
import { startWatchLoop } from './sync/engine.ts';
import { startCommentLoop } from './sync/comments.ts';

// Protocol upgrades bypass the request router entirely — see web/upgrade.ts. Without this
// the sidecar cannot front Immich on its own, because live web updates break.
server.on('upgrade', proxyUpgrade);
server.listen(CFG.port, () => log(`sidecar "${CFG.name}" listening :${CFG.port} — immich: ${CFG.immichUrl}`));
startWatchLoop();
startCommentLoop();
