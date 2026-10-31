import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invalidatePresentAfter, PRESENT_CACHE_TAG, presentCacheHeaders } from '../src/present-cache.ts';

const cutoff = new Date('2026-10-30T17:00:00.000Z');

test('only the shared cache may reuse a present response for up to 60 seconds', () => {
  const headers = presentCacheHeaders(cutoff, new Date('2026-10-31T12:00:00.000Z'));
  assert.equal(headers['cache-control'], 'public, max-age=0, s-maxage=60, must-revalidate');
  assert.equal(headers['cache-tag'], PRESENT_CACHE_TAG);
  assert.equal(headers.expires, 'Sat, 31 Oct 2026 12:01:00 GMT');
});

test('cache lifetime ends before the next 02:00 JST, including a slow query crossing it', () => {
  const headers = presentCacheHeaders(cutoff, new Date('2026-10-31T16:59:50.400Z'));
  assert.match(headers['cache-control'], /s-maxage=9,/);
  assert.ok(new Date(headers.expires).getTime() < Date.parse('2026-10-31T17:00:00.000Z'));
  for (const now of ['2026-10-31T16:59:59.500Z', '2026-10-31T17:00:00.000Z', '2026-10-31T17:00:00.500Z']) {
    assert.deepEqual(presentCacheHeaders(cutoff, new Date(now)), { 'cache-control': 'no-store' });
  }
});

test('a successful mutation waits for global purge before returning', async () => {
  let complete!: (value: { success: boolean; errors: never[] }) => void;
  const pending = new Promise<{ success: boolean; errors: never[] }>(resolve => { complete = resolve; });
  const calls: unknown[] = [];
  const response = new Response('{}');
  let returned = false;
  const mutation = invalidatePresentAfter(response, {
    purge: async options => { calls.push(options); return pending; },
  }).then(result => { returned = true; return result; });
  await Promise.resolve();
  assert.equal(returned, false);
  assert.deepEqual(calls, [{ tags: [PRESENT_CACHE_TAG] }]);
  complete({ success: true, errors: [] });
  assert.equal(await mutation, response);
});

test('failed mutations do not purge, and committed mutations remain successful on purge failure', async t => {
  let calls = 0;
  const cache = { purge: async () => { calls++; return { success: true, errors: [] }; } };
  const invalid = new Response('{}', { status: 401 });
  assert.equal(await invalidatePresentAfter(invalid, cache), invalid);
  assert.equal(calls, 0);
  const success = new Response('{}');
  assert.equal(await invalidatePresentAfter(success, undefined), success);
  const log = t.mock.method(console, 'error', () => {});
  assert.equal(await invalidatePresentAfter(success, { purge: async () => ({ success: false, errors: ['rate limit'] }) }), success);
  assert.equal(await invalidatePresentAfter(success, { purge: async () => { throw new Error('unavailable'); } }), success);
  assert.equal(log.mock.callCount(), 2);
});
