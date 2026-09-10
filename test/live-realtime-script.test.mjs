import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptRealtimeTransport } from '../scripts/test-live-realtime.mjs';

test('live reconnect acceptance interrupts the socket without invoking manual-disconnect behavior', () => {
  let closes = 0;
  const socket = { readyState: 1, close(code) { closes++; assert.equal(code, 4000); this.readyState = 3; } };
  const realtime = { conn: socket, disconnect() { throw new Error('Manual disconnect disables automatic recovery.'); }, connect() { throw new Error('Recovery must be driven by the client.'); } };
  assert.equal(interruptRealtimeTransport(realtime), socket);
  assert.equal(closes, 1);
  assert.throws(() => interruptRealtimeTransport(realtime), /open realtime transport/);
  for (const conn of [null, { readyState: 0, close() {} }, { readyState: 1 }]) assert.throws(() => interruptRealtimeTransport({ conn }), /open realtime transport/);
});
