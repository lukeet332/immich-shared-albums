/** index.ts — composition root: starts the iroh transport, the HTTP server and the three sync loops. See ARCHITECTURE.md. */
import { CFG, log } from './config.ts';
import { server } from './web/server.ts';
import { proxyUpgrade } from './web/upgrade.ts';
import { verifyAdminKeyAtBoot } from './immich/admin-key.ts';
import { startTransport } from './p2p/transport.ts';
import { helloPeers } from './peers.ts';
import { peerRoutes } from './p2p/routes.ts';
import { startWatchLoop } from './sync/engine.ts';
import { startCommentLoop } from './sync/comments.ts';
import { startInviteLoop } from './sync/invites.ts';

// A sidecar must never die silently: an unhandled async error should be logged and swallowed
// (the loops are all independently retrying), not take the process down with no trace. A truly
// fatal state still exits, but only after saying why.
process.on('unhandledRejection', reason => {
  log('UNHANDLED REJECTION (kept alive):', reason instanceof Error ? reason.stack : String(reason));
});
process.on('uncaughtException', err => {
  log('UNCAUGHT EXCEPTION (kept alive):', err.stack || String(err));
});

// Protocol upgrades bypass the request router entirely — see web/upgrade.ts. Without this
// the sidecar cannot front Immich on its own, because live web updates break.
server.on('upgrade', proxyUpgrade);
// The transport binds first: the share page mints endpoint tokens from it on every request.
void verifyAdminKeyAtBoot();
await startTransport(peerRoutes);
void helloPeers(); // refresh what each linked peer can do — deliberately unawaited
server.listen(CFG.port, () => log(`sidecar "${CFG.name}" listening :${CFG.port} — immich: ${CFG.immichUrl}`));
startWatchLoop();
startCommentLoop();
startInviteLoop();
