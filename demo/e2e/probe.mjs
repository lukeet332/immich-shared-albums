// e2e/probe.mjs — one iroh request from inside the rig's network, for the assertion suite.
// The suite runs on the host, which cannot dial container IPs; this runs via
// `docker run --network isa-demo` and prints the result as JSON on stdout.
// argv[2] = JSON { keys:{pub,priv}, peerPub, addrs:[...], path, body?, range?, wantBytes? }
import { bindAs, request } from './iroh-client.mjs';

const job = JSON.parse(process.argv[2]);
// Large test bodies are synthesized HERE: passing megabytes through docker's argv hits E2BIG.
if (job.bodyPad) job.body = { pad: 'x'.repeat(job.bodyPad) };
const ep = await bindAs(job.keys);
try {
  const res = await request(ep, job.peerPub, job.addrs, job.path, {
    body: job.body,
    range: job.range,
    wantBytes: job.wantBytes,
  });
  console.log(JSON.stringify(res));
  process.exit(0);
} catch (e) {
  console.log(JSON.stringify({ error: String(e.message || e) }));
  process.exit(0);
}
