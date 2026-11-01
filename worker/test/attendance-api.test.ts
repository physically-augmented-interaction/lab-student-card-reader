import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker, { type Env } from '../src/index.ts';
import { PRESENT_CACHE_TAG } from '../src/present-cache.ts';

async function fixture() {
  const db = new DatabaseSync(':memory:');
  const queries: string[] = [];
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
        queries.push(sql);
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
  return { db, env, ctx, token, purges, queries, request };
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

test('attendance resets at 02:00 JST, including month, year, and leap-day boundaries', async t => {
  const cases = [
    { label: 'midnight continues the previous session', previous: '2026-10-31T14:00:00.000Z', now: '2026-10-31T15:30:00.000Z', expected: 'leave' },
    { label: 'just before 02:00 is still present', previous: '2026-10-31T16:00:00.000Z', now: '2026-10-31T16:59:59.999Z', expected: 'leave' },
    { label: '02:00 exactly starts a new session at the month boundary', previous: '2026-10-31T16:59:59.999Z', now: '2026-10-31T17:00:00.000Z', expected: 'enter' },
    { label: 'an entry at 02:00 belongs to the new session', previous: '2026-10-31T17:00:00.000Z', now: '2026-10-31T17:00:01.000Z', expected: 'leave' },
    { label: 'an old unclosed visit expires after multiple days', previous: '2026-10-25T04:00:00.000Z', now: '2026-11-01T03:00:00.000Z', expected: 'enter' },
    { label: 'year boundary', previous: '2026-12-31T16:00:00.000Z', now: '2026-12-31T17:00:00.000Z', expected: 'enter' },
    { label: 'leap day boundary', previous: '2028-02-29T16:00:00.000Z', now: '2028-02-29T17:00:00.000Z', expected: 'enter' },
  ];
  for (const scenario of cases) {
    await t.test(scenario.label, async subtest => {
      subtest.mock.timers.enable({ apis: ['Date'], now: new Date(scenario.now) });
      const f = await fixture();
      try {
        f.db.prepare('INSERT INTO members (student_id, display_name) VALUES (?, ?)').run('TEST01', 'Boundary member');
        f.db.prepare('INSERT INTO visits (id, student_id, event_type, occurred_at) VALUES (?, ?, ?, ?)')
          .run('seed', 'TEST01', 'enter', scenario.previous);
        const before = await (await f.request('/api/present')).json();
        assert.equal(before.present.length, scenario.expected === 'leave' ? 1 : 0);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM visits').get()!.n, 1);
        assert.equal(f.purges.length, 0);
        const response = await f.request('/api/scan', {
          method: 'POST', headers: { authorization: 'Bearer ' + f.token, 'content-type': 'application/json' },
          body: JSON.stringify({ studentId: 'TEST01' }),
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.eventType, scenario.expected);
        assert.equal(result.occurredAt, scenario.now);
        assert.equal(result.present.length, scenario.expected === 'enter' ? 1 : 0);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM visits').get()!.n, 2);
        assert.equal(f.db.prepare('SELECT event_type FROM visits WHERE id = ?').get('seed')!.event_type, 'enter');
      } finally { f.db.close(); }
    });
  }
});

test('a scan whose database lookup crosses 02:00 uses its recorded timestamp to decide the event', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-31T16:59:59.999Z') });
  const f = await fixture();
  try {
    f.db.prepare('INSERT INTO members (student_id) VALUES (?)').run('TEST01');
    f.db.prepare('INSERT INTO visits (id, student_id, event_type, occurred_at) VALUES (?, ?, ?, ?)')
      .run('seed', 'TEST01', 'enter', '2026-10-31T16:00:00.000Z');
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = sql => {
      if (sql.includes('ORDER BY occurred_at DESC LIMIT 1')) t.mock.timers.tick(2);
      return prepare(sql);
    };
    const response = await f.request('/api/scan', {
      method: 'POST', headers: { authorization: 'Bearer ' + f.token, 'content-type': 'application/json' },
      body: JSON.stringify({ studentId: 'TEST01' }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.occurredAt, '2026-10-31T17:00:00.001Z');
    assert.equal(result.eventType, 'enter');
    assert.equal(result.present.length, 1);
  } finally { f.db.close(); }
});

test('automatic departure changes live state while preserving actual history and today entries', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-31T17:00:00.000Z') });
  const f = await fixture();
  try {
    f.db.prepare('INSERT INTO members (student_id, display_name) VALUES (?, ?)').run('TEST01', 'Expired member');
    f.db.prepare('INSERT INTO visits (id, student_id, event_type, occurred_at) VALUES (?, ?, ?, ?)')
      .run('seed', 'TEST01', 'enter', '2026-10-31T16:00:00.000Z');
    const member = await (await f.request('/api/members/TEST01')).json();
    assert.equal(member.lastVisit.event_type, 'enter');
    const data = await (await f.request('/api/dashboard?month=2026-11')).json();
    assert.deepEqual(data.summary.presentMembers, []);
    assert.equal(data.summary.presentNow, 0);
    assert.deepEqual(data.summary.todayEnterMembers, [{ studentId: 'TEST01', displayName: 'Expired member' }]);
    assert.equal(data.summary.todayEnterUnique, 1);
    assert.equal(data.summary.leaveCount, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM visits').get()!.n, 1);
    assert.equal(f.purges.length, 0);
  } finally { f.db.close(); }
});

test('dashboard names match the unique counts and stay current when selecting another month', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T03:00:00.000Z') });
  const f = await fixture();
  try {
    const member = f.db.prepare('INSERT INTO members (student_id, display_name) VALUES (?, ?)');
    for (const entry of [['STUDENTA', '山田 太郎'], ['STUDENTB', ''], ['STUDENTC', '<b>花子</b>'], ['STUDENTD', '前日だけ'], ['STUDENTE', '退室のみ']]) member.run(...entry);
    const insert = f.db.prepare('INSERT INTO visits (id, student_id, event_type, occurred_at) VALUES (?, ?, ?, ?)');
    const visits = [
      ['STUDENTA', 'enter', '2026-11-01T00:00:00.000Z'],
      ['STUDENTA', 'leave', '2026-11-01T01:00:00.000Z'],
      ['STUDENTA', 'enter', '2026-11-01T02:00:00.000Z'],
      ['STUDENTB', 'enter', '2026-11-01T00:05:00.000Z'],
      ['STUDENTB', 'leave', '2026-11-01T01:05:00.000Z'],
      ['STUDENTC', 'enter', '2026-10-31T16:00:00.000Z'],
      ['STUDENTD', 'enter', '2026-10-31T14:00:00.000Z'],
      ['STUDENTE', 'leave', '2026-11-01T01:30:00.000Z'],
    ];
    visits.forEach((visit, i) => insert.run(String(i), ...visit));
    let current;
    for (const month of ['2026-11', '2026-10']) {
      const before = f.queries.length;
      const response = await f.request('/api/dashboard?month=' + month);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.summary.todayEnterUnique, 3);
      assert.deepEqual(data.summary.todayEnterMembers.map(row => row.studentId).sort(), ['STUDENTA', 'STUDENTB', 'STUDENTC']);
      assert.equal(data.summary.todayEnterMembers.find(row => row.studentId === 'STUDENTB').displayName, 'STUDENTB');
      assert.equal(data.summary.presentNow, 1);
      assert.equal(data.summary.presentMembers.length, 1);
      assert.equal(data.summary.presentMembers[0].studentId, 'STUDENTA');
      assert.equal(data.summary.presentMembers[0].displayName, '山田 太郎');
      assert.equal(data.generatedAt, '2026-11-01T03:00:00.000Z');
      assert.equal(data.refreshAt, '2026-11-01T15:00:00.000Z');
      assert.equal(f.queries.length - before, month === '2026-11' ? 2 : 3);
      if (current) assert.deepEqual(data.summary.todayEnterMembers, current.summary.todayEnterMembers);
      current = data;
    }
  } finally { f.db.close(); }
});

test('empty dashboard schedules the next midnight or 02:00 JST boundary', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-31T15:30:00.000Z') });
  const f = await fixture();
  try {
    const beforeReset = await (await f.request('/api/dashboard?month=2026-11')).json();
    assert.equal(beforeReset.refreshAt, '2026-10-31T17:00:00.000Z');
    assert.deepEqual(beforeReset.summary.todayEnterMembers, []);
    assert.deepEqual(beforeReset.summary.presentMembers, []);
    assert.equal(beforeReset.summary.todayEnterUnique, 0);
    assert.equal(beforeReset.summary.presentNow, 0);
    t.mock.timers.tick(90 * 60 * 1000);
    const afterReset = await (await f.request('/api/dashboard?month=2026-11')).json();
    assert.equal(afterReset.refreshAt, '2026-11-01T15:00:00.000Z');
  } finally { f.db.close(); }
});
