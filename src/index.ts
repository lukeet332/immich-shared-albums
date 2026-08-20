/** index.ts — composition root: starts the HTTP server and the sync loops. See ARCHITECTURE.md. */
import { CFG, log } from './config.ts';
import { server } from './web/server.ts';
import { proxyUpgrade } from './web/upgrade.ts';
import { startWatchLoop } from './sync/engine.ts';
import { startCommentLoop } from './sync/comments.ts';
import { startInviteLoop } from './sync/invites.ts';

server.on('upgrade', proxyUpgrade);
server.listen(CFG.port, () => log(`sidecar "${CFG.name}" listening :${CFG.port} — immich: ${CFG.immichUrl}`));
startWatchLoop();
startCommentLoop();
startInviteLoop();
