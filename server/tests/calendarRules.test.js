import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, weekRange } from '../src/utils/dates.js';
import { MAX_RANGE_DAYS, parseCalendarQuery } from '../src/validators/calendarQueryValidator.js';

const NOW = '2026-10-21T14:30';

describe('week and range helpers (no database needed)', () => {
  test('weekRange: Monday to Sunday, for every day of one week', () => {
    for (const day of ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']) {
      assert.deepEqual(weekRange(day), { from: '2026-10-19', to: '2026-10-25' }, day);
    }
  });

  test('weekRange: the neighbouring weeks, month ends, year ends and a leap day', () => {
    assert.deepEqual(weekRange('2026-10-18'), { from: '2026-10-12', to: '2026-10-18' }, 'a Sunday belongs to the week that ends on it');
    assert.deepEqual(weekRange('2026-10-26'), { from: '2026-10-26', to: '2026-11-01' }, 'a Monday starts its own week, across a month end');
    assert.deepEqual(weekRange('2027-01-01'), { from: '2026-12-28', to: '2027-01-03' }, 'across a year end');
    assert.deepEqual(weekRange('2028-02-29'), { from: '2028-02-28', to: '2028-03-05' }, 'leap day');
    assert.deepEqual(weekRange('2024-03-01'), { from: '2024-02-26', to: '2024-03-03' }, 'a leap February');
  });

  test('daysBetween counts whole days, also across month, year, leap day and clock changes', () => {
    assert.equal(daysBetween('2026-10-21', '2026-10-21'), 0);
    assert.equal(daysBetween('2026-10-21', '2026-10-22'), 1);
    assert.equal(daysBetween('2026-10-22', '2026-10-21'), -1);
    assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
    assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2);
    assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2, 'a daylight-saving weekend');
    assert.equal(daysBetween('2026-01-01', '2027-01-01'), 365);
  });
});

describe('calendar query validation (no database needed)', () => {
  const parse = (query) => parseCalendarQuery({ now: NOW, ...query });
  const fails = (query, field) => {
    assert.throws(
      () => parse(query),
      (error) => error.statusCode === 400 && (field === undefined || error.details?.some((d) => d.field === field)),
      JSON.stringify(query),
    );
  };

  test('a valid request returns the range, every kind, no subject filter and the given clock', () => {
    const parsed = parse({ from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual([parsed.from, parsed.to], ['2026-10-01', '2026-10-31']);
    assert.deepEqual(parsed.types, ['assignment', 'task', 'session']);
    assert.equal(parsed.subject, undefined);
    assert.deepEqual(parsed.now, { date: '2026-10-21', time: '14:30' });
  });

  test('types: a list keeps the canonical order and drops repeats', () => {
    assert.deepEqual(parse({ from: '2026-10-01', to: '2026-10-31', types: 'session,task,task' }).types, ['task', 'session']);
    assert.deepEqual(parse({ from: '2026-10-01', to: '2026-10-31', types: 'assignment' }).types, ['assignment']);
  });

  test('subject: a real id becomes an ObjectId; anything else is rejected', () => {
    const parsed = parse({ from: '2026-10-01', to: '2026-10-31', subject: '64b7f0c2a1b2c3d4e5f60718' });
    assert.equal(parsed.subject.toString(), '64b7f0c2a1b2c3d4e5f60718');
    for (const subject of ['abc', 'none', '64b7f0c2a1b2c3d4e5f6071', '64b7f0c2a1b2c3d4e5f60718x', ['64b7f0c2a1b2c3d4e5f60718'], { $ne: 'x' }]) {
      fails({ from: '2026-10-01', to: '2026-10-31', subject }, 'subject');
    }
  });

  test('from and to are required, real dates, in order', () => {
    fails({ to: '2026-10-31' }, 'from');
    fails({ from: '2026-10-01' }, 'to');
    fails({}, 'from');
    for (const bad of ['2026-02-30', '2026-13-01', '2026-10-1', 'today', '2026-10-01T00:00', ['2026-10-01'], { $gte: '2000-01-01' }]) {
      fails({ from: bad, to: '2026-10-31' }, 'from');
      fails({ from: '2026-10-01', to: bad }, 'to');
    }
    fails({ from: '2026-10-31', to: '2026-10-01' });
  });

  test('the range limit: exactly 62 days passes, 63 fails (also over a leap day)', () => {
    assert.equal(MAX_RANGE_DAYS, 62);
    assert.doesNotThrow(() => parse({ from: '2026-09-01', to: '2026-11-01' }));
    fails({ from: '2026-09-01', to: '2026-11-02' });
    assert.doesNotThrow(() => parse({ from: '2028-01-30', to: '2028-03-31' }), 'Jan 30 to Mar 31 in a leap year is 62 days');
    fails({ from: '2028-01-30', to: '2028-04-01' });
    fails({ from: '2000-01-01', to: '2100-12-31' });
  });

  test('types: unknown kinds, empty items and wrong case are rejected', () => {
    for (const types of ['holiday', 'task,holiday', 'task,,session', ',task', 'Task', ['task', 'session']]) {
      fails({ from: '2026-10-01', to: '2026-10-31', types }, 'types');
    }
  });

  test('now must be a real local date and time', () => {
    fails({ from: '2026-10-01', to: '2026-10-31', now: 'tomorrow' }, 'now');
    fails({ from: '2026-10-01', to: '2026-10-31', now: '2026-02-30T10:00' }, 'now');
  });
});
