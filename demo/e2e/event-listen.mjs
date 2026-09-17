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
 *
 * `seq` counts from zero in EACH sidecar, so every counter here is keyed by `source`. A single
 * counter across three emitters is not a slower correctness check but a wrong one: the chattiest
 * sidecar raises the global high-water mark, and every quieter sidecar's events then look like
 * duplicates of it and are discarded.
 */
import http from 'node:http';

const PORT = Number(process.env.E2E_EVENT_PORT || 8400);

/** Events kept for `seenEvents()`, oldest first. Retained so a wait can match one that already
 *  happened — the work usually starts on the line before the wait. */
const seen = [];
const waiters = [];
/** Highest `seq` already accepted, per emitting household. */
const lastSeqBySource = new Map();
/** Per-source counters are not comparable; this only orders the dump. */
let eventsAccepted = 0;

const matches = (event, type, filter) =>
  (type === '*' || event.type === type) &&
  (!filter.albumId || event.albumId === filter.albumId) &&
  (!filter.albumName || event.albumName === filter.albumName) &&
  (!filter.mappingId || event.mappingId === filter.mappingId) &&
  (!filter.source || event.source === filter.source);

const dispatch = event => {
  if (typeof event?.seq !== 'number' || !event.source) return;
  const highWater = lastSeqBySource.get(event.source) || 0;
  if (event.seq <= highWater) return; // duplicate: push and replay overlap
  lastSeqBySource.set(event.source, event.seq);
  seen.push({ ...event, order: ++eventsAccepted });
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (matches(event, waiters[i].type, waiters[i].filter) && event.seq > waiters[i].afterSeq) {
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

/** Wait for ONE fact: this sidecar (`source`) did this to this album (`albumId`).
 *
 *  Declarative on purpose — no wildcard, no predicate. `afterSeq` is where this source's stream
 *  had got to when the test last looked, so a wait means "the NEXT one", not "any one ever".
 *  `catchUp` names that source's own HTTP endpoint, so a missed delivery is replayed rather than
 *  waited out; passing the wrong sidecar there would replay a different stream under this key. */
export function waitForEvent(type, filter = {}, { timeoutMs = 30000, catchUp, everyMs = 250, afterSeq = 0 } = {}) {
  const already = seen.find(e => matches(e, type, filter) && e.seq > afterSeq);
  if (already) return Promise.resolve(already);

  return new Promise((resolve, reject) => {
    let replayTimer;
    const waiter = {
      type,
      filter,
      afterSeq,
      resolve: event => {
        clearInterval(replayTimer);
        clearTimeout(deadline);
        resolve(event);
      },
    };
    waiters.push(waiter);

    if (catchUp) {
      replayTimer = setInterval(async () => {
        try {
          const since = lastSeqBySource.get(filter.source) || 0;
          const r = await fetch(`${catchUp.base}/immich-shared-albums/events?since=${since}`, {
            headers: { 'x-api-key': catchUp.key },
          });
          if (r.ok) for (const e of (await r.json()).events || []) dispatch(e);
        } catch {
          /* the next tick tries again */
        }
      }, everyMs);
    }

    const deadline = setTimeout(() => {
      clearInterval(replayTimer);
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      const what = filter.albumId ? `album ${String(filter.albumId).slice(0, 8)}` : 'any album';
      const from = filter.source ? ` from '${filter.source}'` : '';
      reject(
        new Error(
          `waited ${timeoutMs}ms for '${type}'${from} on ${what}; saw ` +
            (seen.map(e => `${e.source}:${e.type}`).join(', ') || '(nothing)')
        )
      );
    }, timeoutMs);
  });
}

/** Forget everything accepted up to `order`, so a later dump repeats nothing. */
export function consumeUpTo(order) {
  for (let i = seen.length - 1; i >= 0; i--) if (seen[i].order <= order) seen.splice(i, 1);
}

export const seenEvents = () => seen.slice();
export const lastEventOrder = () => eventsAccepted;
