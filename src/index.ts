/** index.ts — composition root: starts the iroh transport, the HTTP server and the three sync loops. See ARCHITECTURE.md. */
import { CFG, log } from './config.ts';
import { server } from './web/server.ts';
import { proxyUpgrade } from './web/upgrade.ts';
import { verifyAdminKeyAtBoot } from './immich/admin-key.ts';
import { migrateUtilityDomain } from './immich/migrate-domain.ts';
import { startTransport } from './p2p/transport.ts';
import { helloPeers } from './peers.ts';
import { peerRoutes } from './p2p/routes.ts';
import { startWatchLoop } from './sync/engine.ts';
import { startCommentLoop } from './sync/comments.ts';
import { startInviteLoop } from './sync/invites.ts';
import { exitOnTerminationSignals } from './shutdown.ts';

// A sidecar must never die silently: an unhandled async error should be logged and swallowed
// (the loops are all independently retrying), not take the process down with no trace. A truly
// fatal state still exits, but only after saying why.
process.on('unhandledRejection', reason => {
  log('UNHANDLED REJECTION (kept alive):', reason instanceof Error ? reason.stack : String(reason));
});
process.on('uncaughtException', err => {
  log('UNCAUGHT EXCEPTION (kept alive):', err.stack || String(err));
});

// Node is PID 1 here (exec-form CMD, no init), and the kernel ignores a signal a PID-1 process has
// no handler for — so without this a `docker stop` waits out its whole grace period and SIGKILLs us.
// See shutdown.ts for why that matters; the handler itself must never be replaced.
exitOnTerminationSignals(server, log);

// Protocol upgrades bypass the request router entirely — see web/upgrade.ts. Without this
// the sidecar cannot front Immich on its own, because live web updates break.
server.on('upgrade', proxyUpgrade);
// The transport binds first: the share page mints endpoint tokens from it on every request.
void verifyAdminKeyAtBoot();
// One-time rename of any bot account still on a legacy email domain — cosmetic, unawaited.
void migrateUtilityDomain();
await startTransport(peerRoutes);
void helloPeers(); // refresh what each linked peer can do — deliberately unawaited
server.listen(CFG.port, () => log(`sidecar "${CFG.name}" listening :${CFG.port} — immich: ${CFG.immichUrl}`));
startWatchLoop();
startCommentLoop();
startInviteLoop();
