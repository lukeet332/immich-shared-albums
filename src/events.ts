/**
 * events.ts — what this sidecar actually did, published as it happens.
 *
 * Every wait outside this process used to be a guess: a caller could only inspect the resulting
 * state and poll until it looked right, because nothing ever said "that finished". These are the
 * moments the sync code already knows about — a ref materialised, a push landed, a mirror torn
 * down — announced as they occur.
 *
 * Purely observational: emitting changes no behaviour, and every timer runs exactly as before.
 * The ring buffer is the safety net — a caller resumes from the last `seq` it saw, so a dropped
 * callback degrades to one small read instead of a caller waiting forever.
 */
import { CFG } from './config.ts';

export type SidecarEvent = {
  /** The household that did it. Emitted by the sender rather than inferred by the listener: with
   *  three sidecars POSTing to one runner, "which one acted" is part of the event. */
  source: string;
  /** Monotonic within a process run. A caller resumes from the last one it saw. */
  seq: number;
  ts: string;
  /** What happened, in the past tense: `materialised`, `pushed`, `mirror.created`, … */
  type: string;
  /** The mapping it concerns, when there is one. Stable and unique per side — this is what a
   *  caller filters on. */
  mappingId?: string;
  /** The local album's id (a UUID). The stable identity of the album acted on: `albumName` is a
   *  DISPLAY name — it can repeat, and on a member it is the local mirror's name, which a
   *  configured template makes different from the origin's. */
  albumId?: string;
  /** Human-readable, for log lines and failure messages. Never filter on this. */
  albumName?: string;
  /** Free-form, type-specific facts. Kept small: this rides in a JSON body. */
  detail?: Record<string, unknown>;
};

const MAX_EVENTS = 500;
const buffer: SidecarEvent[] = [];
let seq = 0;

/** The events after `since`, oldest first. `since: 0` means everything still retained. */
export const eventsSince = (since: number): SidecarEvent[] => buffer.filter(e => e.seq > since);

export const eventCount = () => seq;

/** Record that something happened.
 *
 *  Never throws, never awaits, and costs an unconfigured caller nothing but an array push.
 *  Delivery failure is the caller's problem to recover from, by asking for everything after the
 *  last `seq` it saw. */
export function emit(type: string, fields: Omit<SidecarEvent, 'seq' | 'ts' | 'type' | 'source'> = {}): void {
  const event: SidecarEvent = { seq: ++seq, ts: new Date().toISOString(), source: CFG.name, type, ...fields };
  buffer.push(event);
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
  const url = CFG.testCallbackUrl;
  if (!url) return;
  // `void` marks the deliberate drop: a slow or absent listener must never stall a sync pass.
  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    /* the buffer is the durable half — the callback is the fast path */
  });
}
