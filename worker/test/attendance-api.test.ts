import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker, { type Env } from '../src/index.ts';
import { PRESENT_CACHE_TAG } from '../src/present-cache.ts';

async function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const migration of ['0001_init.sql', '0002_enter_leave_sounds.sql']) {
    db.exec(readFileSync(new URL('../migrations/' + migration, import.meta.url), 'utf8'));
  }
  const token = 'test-fixture-token';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = Buffer.from(digest).toString('hex');
  db.prepare('INSERT INTO api_keys (id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?)')
    .run('key', 'test', hash, 'test');
  const env = {
    APP_TIMEZONE: 'Asia/Tokyo',
    ASSETS: { fetch: async () => new Response('asset') },
    DB: {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...args: unknown[]) { values = args; return this; },
          async first() { return db.prepare(sql).get(...values) ?? null; },
          async all() { return { results: db.prepare(sql).all(...values) }; },
          async run() { return { meta: db.prepare(sql).run(...values) }; },
        };
      },
    },
  } as unknown as Env;
  const purges: unknown[] = [];
  const ctx = {
    cache: { purge: async (options: unknown) => { purges.push(options); return { success: true, errors: [] }; } },
  } as unknown as ExecutionContext;
  const request = (path: string, init?: RequestInit) => worker.fetch(new Request('https://test.example' + path, init), env, ctx);
  return { db, env, ctx, token, purges, request };
}

test('only present GETs opt into caching; development and failed reads stay uncached', async () => {
  const f = await fixture();
  try {
    const present = await f.request('/api/present');
    assert.equal(present.status, 200);
    assert.match(present.headers.get('cache-control')!, /s-maxage=\d+/);
    assert.equal(present.headers.get('cache-tag'), PRESENT_CACHE_TAG);
    const data = await present.json();
    assert.deepEqual(data.present, []);
    assert.ok(data.cutoffAt.endsWith('T17:00:00.000Z'));
    assert.equal((await f.request('/api/health')).headers.get('cache-control'), 'no-store');
    assert.equal((await f.request('/api/members')).headers.get('cache-control'), 'no-store');
    const local = await worker.fetch(new Request('https://test.example/api/present'), f.env, {} as ExecutionContext);
    assert.equal(local.headers.get('cache-control'), 'no-store');
    const broken = { ...f.env, DB: { prepare: () => { throw new Error('database unavailable'); } } } as unknown as Env;
    const error = await worker.fetch(new Request('https://test.example/api/present'), broken, f.ctx);
    assert.equal(error.status, 500);
    assert.equal(error.headers.get('cache-control'), 'no-store');
  } finally { f.db.close(); }
});

test('scans return the new presence immediately and purge after committed writes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-31T12:00:00.000Z') });
  const f = await fixture();
  try {
    const scan = () => f.request('/api/scan', {
      method: 'POST', headers: { authorization: 'Bearer ' + f.token, 'content-type': 'application/json' },
      body: JSON.stringify({ studentId: 'TEST01' }),
    });
    const entered = await scan();
    assert.equal(entered.status, 200);
    assert.equal(entered.headers.get('cache-control'), 'no-store');
    const data = await entered.json();
    assert.equal(data.eventType, 'enter');
    assert.equal(data.present[0].studentId, 'TEST01');
    assert.deepEqual(f.purges, [{ tags: [PRESENT_CACHE_TAG] }]);
    t.mock.timers.tick(1000);
    const left = await (await scan()).json();
    assert.equal(left.eventType, 'leave');
    assert.deepEqual(left.present, []);
    assert.equal(f.purges.length, 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM visits').get()!.n, 2);
    assert.equal((await f.request('/api/scan', { method: 'POST', body: '{}' })).status, 401);
    assert.equal(f.purges.length, 2);
  } finally { f.db.close(); }
});

test('renames and successful deletes purge present; missing member deletes do not', async () => {
  const f = await fixture();
  try {
    f.db.prepare('INSERT INTO members (student_id, display_name) VALUES (?, ?)').run('TEST02', 'Before');
    f.db.prepare('INSERT INTO visits (id, student_id, event_type, occurred_at) VALUES (?, ?, ?, ?)')
      .run('visit', 'TEST02', 'enter', new Date().toISOString());
    const renamed = await f.request('/api/members/TEST02', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'After' }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(f.purges.length, 1);
    const present = await (await f.request('/api/present')).json();
    assert.equal(present.present[0].displayName, 'After');
    f.db.prepare('INSERT INTO members (student_id) VALUES (?)').run('UNUSED');
    assert.equal((await f.request('/api/members/UNUSED', { method: 'DELETE' })).status, 200);
    assert.equal(f.purges.length, 2);
    assert.equal((await f.request('/api/members/NONE', { method: 'DELETE' })).status, 404);
    assert.equal(f.purges.length, 2);
  } finally { f.db.close(); }
});
