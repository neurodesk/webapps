import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticLines, failureSnapshot } from '../scripts/desktop/smoke-diagnostics.mjs';

test('diagnostic framing preserves fragmented and coalesced lines but removes extra fields', () => {
  const records = [];
  const consume = diagnosticLines(record => records.push(record));
  const safe = { time: '2026-11-04T00:00:00.000Z', diagnostic: 'offline-server', event: 'stream-error', code: 'EIO' };
  const line = JSON.stringify({ ...safe, privatePath: '/secret', url: '?token=secret' });
  consume(line.slice(0, 20)); consume(line.slice(20) + '\n' + line + '\n');
  assert.deepEqual(records, [safe, safe]);
  consume('{"diagnostic":"offline-server","event":"secret"}\n');
  assert.equal(records.length, 2);
});

test('oversized or incomplete records never leak and the next line still parses', () => {
  const records = [];
  const consume = diagnosticLines(record => records.push(record));
  consume('x'.repeat(9000)); consume('\n');
  consume('{"time":"2026-11-04T00:00:00.000Z","diagnostic":"offline-server","event":"close"}\n');
  assert.equal(records.length, 1);
});

test('unresponsive or rejected evaluation cannot block failure recording', async () => {
  assert.equal(await failureSnapshot(() => new Promise(() => {}), 10), undefined);
  assert.equal(await failureSnapshot(() => Promise.reject(new Error('closed')), 10), undefined);
  assert.deepEqual(await failureSnapshot(() => ({ listening: true })), { listening: true });
});

 test('HTTP parser error codes survive filtering without arbitrary text', () => {
 const records = [];
 const consume = diagnosticLines(record => records.push(record));
 for (const code of ['HPE_INVALID_METHOD', 'ECONNRESET', 'private path']) consume(JSON.stringify({ time: '2026-11-04T00:00:00.000Z', diagnostic: 'offline-server', event: 'clientError', code }) + '\n');
 assert.deepEqual(records.map(record => record.code), ['HPE_INVALID_METHOD', 'ECONNRESET', undefined]);
 });
