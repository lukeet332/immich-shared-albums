// rust/frame-interop.mjs — prove the Rust isa/2 frame codec interoperates with the INDEPENDENT
// implementation in demo/e2e/iroh-client.mjs, over a real socket. If these two disagree, a Rust
// peer cannot talk to a Node peer, whatever our own round-trip tests say.
//
// Run:
//   cd rust && cargo build --example frame_server
//   ./target/debug/examples/frame_server 9501 &
//   node frame-interop.mjs 9501
import net from 'node:net';

const PORT = Number(process.argv[2] || 9500);

// ---- copied verbatim from demo/e2e/iroh-client.mjs ----
const framed = payload => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(payload.length);
  return Buffer.concat([len, payload]);
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

/** Send an oracle-framed request, then read the whole reply and split it into frames. */
async function exchange(reqHeader, reqBody) {
  const sock = net.connect(PORT, '127.0.0.1');
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  const chunks = [];
  sock.on('data', d => chunks.push(d));
  const done = new Promise(res => sock.on('end', res));
  await new Promise(res =>
    sock.write(
      Buffer.concat([
        framed(Buffer.from(JSON.stringify(reqHeader))),
        framed(reqBody === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(reqBody))),
      ]),
      res
    )
  );
  sock.end();
  await done;
  const all = Buffer.concat(chunks);

  // readFramed's exact rule: a u32-LE length, then that many bytes; 0 means empty.
  let off = 0;
  const readFramedFrom = buf => {
    const len = buf.readUInt32LE(off);
    off += 4;
    const out = len === 0 ? Buffer.alloc(0) : buf.subarray(off, off + len);
    off += len;
    return out;
  };
  const head = JSON.parse(readFramedFrom(all).toString());
  const rest = all.subarray(off);
  return { head, rest };
}

// ---- a bodyless JSON request, as /hello is dialled ----
{
  const { head, rest } = await exchange({ path: '/hello' }, null);
  check('the Rust side read a header the JS oracle framed', head.status === 200, JSON.stringify(head));
  check('the JS oracle can read the response header the Rust side framed', head.status === 200);
  const body = JSON.parse(rest.toString());
  check('the Rust side read the path the oracle sent', body.echo_path === '/hello', body.echo_path);
  check(
    'a bodyless request read back as EMPTY, not as missing',
    body.body_len === 0 && body.echo_body === null,
    `body_len=${body.body_len}`
  );
  check('a JSON response body crosses in the oracle\'s shape', body.protocol === 2);
}

// ---- a request with a Range and a JSON body, as /refs and /playback are dialled ----
{
  const { head, rest } = await exchange(
    { path: '/assets/a1/playback', range: 'bytes=0-2097151' },
    { add: ['x'] }
  );
  check('response head readable for a second request', head.status === 200);
  const body = JSON.parse(rest.toString());
  check('a Range survives the Rust codec verbatim', body.echo_range === 'bytes=0-2097151', String(body.echo_range));
  check(
    'a JSON request body survives the Rust codec',
    JSON.stringify(body.echo_body) === '{"add":["x"]}',
    JSON.stringify(body.echo_body)
  );
}

// ---- an over-limit body must be DRAINED and answered 413, not abandoned ----
{
  const big = 'x'.repeat(1200 * 1024); // past the 1 MiB body frame cap
  const { head, rest } = await exchange({ path: '/albums/a1/refs' }, { pad: big });
  check('an over-limit body is answered rather than abandoned', head.status === 413, `status=${head.status}`);
  const body = JSON.parse(rest.toString());
  check(
    'and it says why, in the shape the protocol uses',
    body.code === 'body_too_large' && /exceeds the/.test(body.error || ''),
    body.code
  );
}

console.log(
  `\n${results.every(r => r.ok) ? '✅ FRAME CODEC INTEROPERATES WITH THE INDEPENDENT ORACLE' : '❌ INTEROP FAILURE'} (${results.filter(r => r.ok).length}/${results.length})`
);
process.exit(results.every(r => r.ok) ? 0 : 1);
