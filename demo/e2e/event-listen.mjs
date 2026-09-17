/**
 * demo/e2e/event-listen.mjs — receive sidecar events as they happen, instead of polling for them.
 *
 * The suite used to discover every asynchrony by inspecting state until it looked right, which
 * costs whatever the poll interval is and reports failure as "timed out". `ISA_TEST_CALLBACK`
 * (gated by `ISA_TEST_HOOKS`) POSTs each event here, so a wait resolves on delivery — promptly
 * after the work, rather than at the next tick.
 *
 * Push is the fast path; `GET /events?since=` is the safety net. A delivery dropped while this
 * listener was busy is replayed from the last `seq` seen, so a missed callback costs one small
 * read rather than a hung test.
 */
import http from 'node:http';

const PORT = Number(process.env.E2E_EVENT_PORT || 8400);

const seen = [];
const waiters = [];
let lastSeq = 0;

const matches = (event, type, filter) =>
  (type === '*' || event.type === type) &&
  (!filter.albumName || event.albumName === filter.albumName) &&
  (!filter.mappingId || event.mappingId === filter.mappingId) &&
  (!filter.source || event.source === filter.source);

const dispatch = event => {
  if (typeof event?.seq !== 'number' || event.seq <= lastSeq) return; // duplicate: push and replay overlap
  lastSeq = event.seq;
  seen.push(event);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (event.seq > waiters[i].afterSeq && matches(event, waiters[i].type, waiters[i].filter)) {
      waiters[i].resolve(event);
      waiters.splice(i, 1);
    }
  }
};

/** The listener the sidecars POST to. Must be up before any sidecar work starts. */
export function startEventListener() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') return void res.writeHead(405).end();
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        dispatch(JSON.parse(body));
      } catch {
        /* a malformed body must not take the listener down */
      }
      res.writeHead(204).end();
    });
  });
  return new Promise(resolve => server.listen(PORT, '0.0.0.0', () => resolve(server)));
}

/** Wait for an event of `type` (or any type, with '*'), optionally scoped to an album.
 *
 *  `catchUp` names the sidecar that should have sent it, so a missed delivery is replayed rather
 *  than waited out. No `settle`: driving an extra sync pass changes when work happens, and these
 *  waits observe the system as it already runs. */
export function waitForEvent(
  type,
  filter = {},
  { timeoutMs = 30000, catchUp, everyMs = 250, afterSeq = 0 } = {}
) {
  const already = seen.find(e => e.seq > afterSeq && matches(e, type, filter));
  if (already) return Promise.resolve(already);

  return new Promise((resolve, reject) => {
    let repairTimer;
    let deadline;
    const waiter = {
      type,
      filter,
      afterSeq,
      resolve: event => {
        clearInterval(repairTimer);
        clearTimeout(deadline);
        resolve(event);
      },
    };
    waiters.push(waiter);

    if (catchUp) {
      repairTimer = setInterval(async () => {
        try {
          const r = await fetch(`${catchUp.base}/immich-shared-albums/events?since=${lastSeq}`, {
            headers: { 'x-api-key': catchUp.key },
          });
          if (r.ok) for (const e of (await r.json()).events || []) dispatch(e);
        } catch {
          /* the next tick tries again */
        }
      }, everyMs);
    }

    deadline = setTimeout(() => {
      clearInterval(repairTimer);
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      const what = filter.albumName ? `'${filter.albumName}'` : 'any album';
      reject(
        new Error(
          `waited ${timeoutMs}ms for '${type}' on ${what}; saw: ` +
            (seen.map(e => e.type).join(', ') || '(nothing)')
        )
      );
    }, timeoutMs);
  });
}

/** Forget everything up to `seq`, so a subsequent wait blocks for a genuinely new event. */
export function consumeUpTo(seq) {
  for (let i = seen.length - 1; i >= 0; i--) if (seen[i].seq <= seq) seen.splice(i, 1);
}

export const seenEvents = () => seen.slice();
export const lastEventSeq = () => lastSeq;
