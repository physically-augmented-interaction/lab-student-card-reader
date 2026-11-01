import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const commonScript = readFileSync(new URL('../public/common.js', import.meta.url), 'utf8');
const dashboardScript = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');

function dashboardData() {
  return {
    summary: {
      todayEnterUnique: 2,
      presentNow: 1,
      todayEnterMembers: [
        { studentId: 'STUDENT1', displayName: '今日のメンバー' },
        { studentId: 'STUDENT2', displayName: '' },
      ],
      presentMembers: [
        { studentId: 'STUDENT1', displayName: '在室メンバー', enteredAt: '2026-11-01T01:00:00.000Z', enteredAtLabel: '2026/11/01 10:00' },
      ],
    },
    daily: [],
    members: [],
  };
}

type DashboardData = ReturnType<typeof dashboardData> & { generatedAt?: string; refreshAt?: string };

async function renderPage(data: DashboardData) {
  const elements = new Map(['#month', '#error', '#summary', '#chart', '#filters', '#member-stats'].map(selector => {
    const listeners = new Map<string, () => void>();
    return [selector, {
      innerHTML: '',
      textContent: '',
      value: '',
      hidden: false,
      listeners,
      addEventListener(type: string, listener: () => void) { listeners.set(type, listener); },
    }];
  }));
  const requests: string[] = [];
  const timers = new Map<number, { callback: () => Promise<void>; delay: number }>();
  const clearedTimers: number[] = [];
  let timerId = 0;
  const context = createContext({
    document: { querySelector: (selector: string) => elements.get(selector) },
    fetch: async (path: string) => {
      requests.push(path);
      return { ok: true, json: async () => data };
    },
    setInterval() { throw new Error('The dashboard must not start polling'); },
    setTimeout(callback: () => Promise<void>, delay: number) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id: number) {
      clearedTimers.push(id);
      timers.delete(id);
    },
  });
  runInContext(commonScript, context);
  await runInContext(dashboardScript, context);
  assert.equal(elements.get('#error')!.textContent, '');
  return {
    context, requests, timers, clearedTimers,
    summary: () => elements.get('#summary')!.innerHTML,
    async changeMonth(value: string) {
      const monthInput = elements.get('#month')!;
      monthInput.value = value;
      monthInput.listeners.get('change')!();
      await new Promise(resolve => setImmediate(resolve));
    },
    async fireTimer(id: number) {
      const timer = timers.get(id)!;
      timers.delete(id);
      await timer.callback();
    },
  };
}

test('summary cards show their own member names and retain their numeric counts', async () => {
  const page = await renderPage(dashboardData());
  const [, todayCard, presentCard] = page.summary().split('<div class="card">');
  assert.ok(todayCard.includes('<b>2</b>'));
  assert.ok(todayCard.includes('<li>今日のメンバー</li>'));
  assert.ok(todayCard.includes('<li>STUDENT2</li>'));
  assert.ok(!todayCard.includes('在室メンバー'));
  assert.ok(presentCard.includes('<b>1</b>'));
  assert.ok(presentCard.includes('<li>在室メンバー</li>'));
  assert.ok(!presentCard.includes('STUDENT2'));
  assert.equal(page.requests.length, 1);
});

test('summary member display names and fallback IDs are escaped as text', async () => {
  const data = dashboardData();
  data.summary.todayEnterMembers = [
    { studentId: 'STUDENT1', displayName: '<img src=x onerror="alert(1)">' },
    { studentId: 'ID<&>', displayName: '' },
  ];
  const page = await renderPage(data);
  assert.ok(page.summary().includes('<li>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</li>'));
  assert.ok(page.summary().includes('<li>ID&lt;&amp;&gt;</li>'));
  assert.ok(!page.summary().includes('<img'));
});

test('summary cards provide empty states when nobody has entered or is present', async () => {
  const data = dashboardData();
  data.summary = { todayEnterUnique: 0, presentNow: 0, todayEnterMembers: [], presentMembers: [] };
  const page = await renderPage(data);
  assert.ok(page.summary().includes('今日の入室記録はありません'));
  assert.ok(page.summary().includes('だれもいません'));
  assert.ok(!page.summary().includes('<ul'));
});

test('monthly filters do not change the current-day and current-presence summary lists', async () => {
  const page = await renderPage(dashboardData());
  const summary = page.summary();
  runInContext('selectedDate = "2026-10-01"; selectedStudentId = "STUDENT2"; renderDashboard();', page.context);
  assert.equal(page.summary(), summary);
  assert.equal(page.requests.length, 1);
});

test('older responses without snapshot timestamps do not schedule refreshes', async () => {
  const page = await renderPage(dashboardData());
  assert.equal(page.timers.size, 0);
});

test('refreshes at the server-provided boundary and schedules the next one', async () => {
  const data: DashboardData = {
    ...dashboardData(),
    generatedAt: '2026-10-31T14:59:59.000Z',
    refreshAt: '2026-10-31T15:00:00.000Z',
  };
  const page = await renderPage(data);
  assert.equal(page.timers.get(1)?.delay, 1000);
  assert.equal(page.requests.length, 1);

  data.generatedAt = '2026-10-31T15:00:00.000Z';
  data.refreshAt = '2026-10-31T17:00:00.000Z';
  data.summary.presentMembers = [];
  data.summary.presentNow = 0;
  await page.fireTimer(1);

  assert.equal(page.requests.length, 2);
  assert.ok(page.summary().includes('だれもいません'));
  assert.equal(page.timers.size, 1);
  assert.equal(page.timers.get(2)?.delay, 2 * 60 * 60 * 1000);
});

test('a month-change response replaces the previously scheduled boundary timer', async () => {
  const data: DashboardData = {
    ...dashboardData(),
    generatedAt: '2026-10-31T14:59:00.000Z',
    refreshAt: '2026-10-31T15:00:00.000Z',
  };
  const page = await renderPage(data);
  data.generatedAt = '2026-10-31T14:59:30.000Z';
  await page.changeMonth('2026-10');

  assert.equal(page.requests.at(-1), '/api/dashboard?month=2026-10');
  assert.deepEqual(page.clearedTimers, [1]);
  assert.equal(page.timers.size, 1);
  assert.equal(page.timers.get(2)?.delay, 30000);
});
