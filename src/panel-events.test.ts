/** panel-events.test.ts — the hint channel to open panels. See web/http-router.md. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emitPanelEvent,
  panelSubscribers,
  subscribeToPanelEvents,
  type PanelEventType,
} from './panel-events.ts';

test('an open panel hears what changed, and a closed one stops hearing it', () => {
  const heard: PanelEventType[] = [];
  const unsubscribe = subscribeToPanelEvents(type => heard.push(type));
  assert.equal(panelSubscribers(), 1, 'the panel counts as listening while it is open');
  emitPanelEvent('invitations');
  emitPanelEvent('shares');
  assert.deepEqual(heard, ['invitations', 'shares']);
  unsubscribe();
  assert.equal(panelSubscribers(), 0, 'a closed panel is not a subscriber');
  emitPanelEvent('index');
  assert.deepEqual(heard, ['invitations', 'shares'], 'nothing arrives after the socket closed');
});

test('one panel that throws cannot silence the others', () => {
  const heard: PanelEventType[] = [];
  const bad = subscribeToPanelEvents(() => {
    throw new Error('socket already gone');
  });
  const good = subscribeToPanelEvents(type => heard.push(type));
  emitPanelEvent('index');
  assert.deepEqual(heard, ['index'], 'the emitter is not a caller of anyone else’s error handling');
  bad();
  good();
});
