import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { LIST_PRESENT_SQL } from '../src/present-query.ts';

const PREVIOUS_SQL = `
  SELECT v.student_id, v.event_type, v.occurred_at,
         COALESCE(m.display_name, '') AS display_name
  FROM visits v
  LEFT JOIN members m ON m.student_id = v.student_id
  JOIN (
    SELECT student_id, MAX(occurred_at) AS occurred_at
    FROM visits
    GROUP BY student_id
  ) latest ON latest.student_id = v.student_id
    AND latest.occurred_at = v.occurred_at
  WHERE v.occurred_at >= ?
  ORDER BY v.occurred_at DESC
`;

type Event = {
  studentId: string;
  eventType: 'enter' | 'leave';
  occurredAt: string;
};

function database(events: Event[] = []): DatabaseSync {
  // Allow a dangling legacy event to verify the existing LEFT JOIN behavior.
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const insertMember = db.prepare('INSERT INTO members (student_id, display_name) VALUES (?, ?)');
  for (const studentId of new Set(events.map(event => event.studentId))) {
    if (studentId !== 'MISSING') insertMember.run(studentId, `Name ${studentId}`);
  }
  const insertEvent = db.prepare(
    'INSERT INTO visits (id, student_id, event_type, occurred_at) VALUES (?, ?, ?, ?)',
  );
  events.forEach((event, index) => {
    insertEvent.run(String(index), event.studentId, event.eventType, event.occurredAt);
  });
  return db;
}

function normalizedRows(db: DatabaseSync, sql: string, cutoff: string) {
  // The API does not define ordering between events with identical timestamps.
  return db.prepare(sql).all(cutoff)
    .map(row => ({ ...row }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test('matches the previous query across session cutoffs, departures, and legacy events', () => {
  const db = database([
    { studentId: 'OLD', eventType: 'enter', occurredAt: '2026-10-29T12:00:00.000Z' },
    { studentId: 'ACTIVE', eventType: 'leave', occurredAt: '2026-10-30T16:00:00.000Z' },
    { studentId: 'ACTIVE', eventType: 'enter', occurredAt: '2026-10-30T18:00:00.000Z' },
    { studentId: 'DEPARTED', eventType: 'enter', occurredAt: '2026-10-30T18:01:00.000Z' },
    { studentId: 'DEPARTED', eventType: 'leave', occurredAt: '2026-10-30T19:00:00.000Z' },
    { studentId: 'BOUNDARY', eventType: 'enter', occurredAt: '2026-10-30T17:00:00.000Z' },
    { studentId: 'BEFORE', eventType: 'enter', occurredAt: '2026-10-30T16:59:59.999Z' },
    { studentId: 'MISSING', eventType: 'enter', occurredAt: '2026-10-30T20:00:00.000Z' },
    { studentId: 'FUTURE', eventType: 'enter', occurredAt: '2026-11-01T03:00:00.000Z' },
  ]);
  try {
    for (const cutoff of [
      '2026-10-29T17:00:00.000Z',
      '2026-10-30T17:00:00.000Z',
      '2026-10-31T17:00:00.000Z',
      '2026-11-02T17:00:00.000Z',
    ]) {
      assert.deepEqual(normalizedRows(db, LIST_PRESENT_SQL, cutoff), normalizedRows(db, PREVIOUS_SQL, cutoff));
    }
    const result = db.prepare(LIST_PRESENT_SQL).all('2026-10-30T17:00:00.000Z');
    assert.deepEqual(result.map(row => row.student_id), ['FUTURE', 'MISSING', 'DEPARTED', 'ACTIVE', 'BOUNDARY']);
    assert.equal(result.find(row => row.student_id === 'MISSING')?.display_name, '');
    assert.equal(result.find(row => row.student_id === 'DEPARTED')?.event_type, 'leave');
  } finally {
    db.close();
  }
});

test('preserves all latest events tied at the same timestamp', () => {
  const db = database([
    { studentId: 'TIED', eventType: 'enter', occurredAt: '2026-10-30T18:00:00.000Z' },
    { studentId: 'TIED', eventType: 'enter', occurredAt: '2026-10-30T19:00:00.000Z' },
    { studentId: 'TIED', eventType: 'leave', occurredAt: '2026-10-30T19:00:00.000Z' },
  ]);
  try {
    const cutoff = '2026-10-30T17:00:00.000Z';
    const actual = normalizedRows(db, LIST_PRESENT_SQL, cutoff);
    assert.equal(actual.length, 2);
    assert.deepEqual(actual, normalizedRows(db, PREVIOUS_SQL, cutoff));
  } finally {
    db.close();
  }
});

test('returns no rows for an empty database', () => {
  const db = database();
  try {
    assert.deepEqual(db.prepare(LIST_PRESENT_SQL).all('2026-10-30T17:00:00.000Z'), []);
  } finally {
    db.close();
  }
});

test('uses date and member range indexes instead of scanning historical visits', () => {
  const events: Event[] = Array.from({ length: 5_000 }, (_, index) => ({
    studentId: `S${index % 35}`,
    eventType: index % 2 ? 'leave' : 'enter',
    occurredAt: new Date(Date.UTC(2025, 0, 1) + index * 60_000).toISOString(),
  }));
  events.push({ studentId: 'S0', eventType: 'enter', occurredAt: '2026-10-30T18:00:00.000Z' });
  const db = database(events);
  try {
    db.exec('ANALYZE');
    const details = db.prepare(`EXPLAIN QUERY PLAN ${LIST_PRESENT_SQL}`)
      .all('2026-10-30T17:00:00.000Z')
      .map(row => String(row.detail));
    assert.ok(details.some(detail => /SEARCH v USING INDEX visits_occurred_at_idx \(occurred_at>\?\)/.test(detail)), details.join('\n'));
    assert.ok(details.some(detail => /SEARCH newer USING COVERING INDEX visits_student_occurred_idx \(student_id=\? AND occurred_at>\?\)/.test(detail)), details.join('\n'));
    assert.ok(!details.some(detail => /\bSCAN (visits|v|newer)\b/.test(detail)), details.join('\n'));
  } finally {
    db.close();
  }
});
