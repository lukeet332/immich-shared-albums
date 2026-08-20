/** web/upgrade.ts — protocol upgrades (websockets), proxied at the socket level. See http-router.md. */
import net from 'node:net';
import { CFG, log, ROUTE_PREFIX } from '../config.ts';

export function proxyUpgrade(req, socket, head: Buffer): void {
  if ((req.url || '').startsWith(ROUTE_PREFIX)) {
    socket.destroy();
    return;
  }
  let target: URL;
  try {
    target = new URL(CFG.immichUrl);
  } catch {
    socket.destroy();
    return;
  }

  const upstream = net.connect({
    host: target.hostname,
    port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
  });
  const bail = (why: string) => (e?: Error) => {
    if (e) log(`websocket proxy ${why}: ${e.message}`);
    upstream.destroy();
    socket.destroy();
  };
  socket.setNoDelay(true);
  upstream.setNoDelay(true);

  upstream.on('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
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
