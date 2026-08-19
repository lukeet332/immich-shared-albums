/**
 * web/upgrade.ts — protocol upgrades (websockets), proxied at the socket level.
 *
 * Separate from passthrough.ts on purpose: that file speaks request/response through
 * `fetch()`, and an upgrade is neither. `fetch()` cannot carry one at all, so these never
 * reach the router — they arrive on the server's 'upgrade' event and are handled as raw
 * sockets. Two different transports, two files.
 *
 * This is what makes the sidecar viable as the SINGLE front for Immich, which is the
 * simplest thing to install: one reverse-proxy route instead of three path-matched ones in a
 * required order. Immich uses websockets for live web updates, so without this the web app
 * silently loses them — the mobile apps never noticed, which is why the demo rig worked
 * regardless and why the gap went unnoticed for so long.
 */
import net from 'node:net';
import { CFG, log, ROUTE_PREFIX } from '../config.ts';

/**
 * Pipe an upgrade straight through to Immich.
 *
 * Headers are replayed from `rawHeaders`, not the parsed header object: the websocket
 * handshake depends on exact header casing and on duplicates surviving, and the parsed map
 * preserves neither. `head` carries any bytes Node already read past the request headers —
 * dropping it truncates the first frame.
 */
export function proxyUpgrade(req, socket, head: Buffer): void {
  // nothing under our own prefix speaks a websocket — refuse rather than open a socket
  if ((req.url || '').startsWith(ROUTE_PREFIX)) { socket.destroy(); return; }
  let target: URL;
  try { target = new URL(CFG.immichUrl); } catch { socket.destroy(); return; }

  const upstream = net.connect({
    host: target.hostname,
    port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
  });
  const bail = (why: string) => (e?: Error) => {
    if (e) log(`websocket proxy ${why}: ${e.message}`);
    upstream.destroy(); socket.destroy();
  };
  socket.setNoDelay(true);
  upstream.setNoDelay(true);

  upstream.on('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', bail('upstream'));
  socket.on('error', bail('client'));
  upstream.on('close', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
}
