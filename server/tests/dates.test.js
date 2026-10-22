import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, isValidDateString, isValidTimeString, parseNow } from '../src/utils/dates.js';
import { getTiming } from '../src/utils/assignmentTiming.js';

describe('date helpers (no database needed)', () => {
  test('isValidDateString accepts real dates only', () => {
    for (const ok of ['2026-10-21', '2024-02-29', '2000-01-01', '2100-12-31']) assert.equal(isValidDateString(ok), true, ok);
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-10-32', '26-10-21', '2026/10/21', '2026-1-1', '', null, undefined, 20261021, {}, ['2026-10-21']]) {
      assert.equal(isValidDateString(bad), false, String(JSON.stringify(bad)));
    }
  });

  test('isValidTimeString accepts 24-hour HH:mm only', () => {
    for (const ok of ['00:00', '09:05', '23:59']) assert.equal(isValidTimeString(ok), true, ok);
    for (const bad of ['24:00', '12:60', '9:05', '12:5', '12:30:00', '', null, 1230]) assert.equal(isValidTimeString(bad), false, String(bad));
  });

  test('addDays crosses month, year and leap-day boundaries without timezone drift', () => {
    assert.equal(addDays('2026-10-21', 3), '2026-10-24');
    assert.equal(addDays('2026-10-30', 3), '2026-11-02');
    assert.equal(addDays('2026-12-30', 3), '2027-01-02');
    assert.equal(addDays('2024-02-28', 2), '2024-03-01'); // leap year
    assert.equal(addDays('2025-02-28', 1), '2025-03-01');
    assert.equal(addDays('2026-03-08', 1), '2026-03-09'); // a US daylight-saving change day
    assert.equal(addDays('2026-10-21', -21), '2026-09-30');
  });

  test('parseNow reads local date and time, and rejects anything else', () => {
    assert.deepEqual(parseNow('2026-10-21T14:30'), { date: '2026-10-21', time: '14:30' });
    for (const bad of ['2026-10-21', '2026-10-21 14:30', '2026-10-21T14:30:00Z', '2026-02-30T10:00', '2026-10-21T25:00', '', null, undefined, ['2026-10-21T14:30']]) {
      assert.equal(parseNow(bad), null, String(JSON.stringify(bad)));
    }
  });
});

describe('getTiming: overdue / dueSoon / upcoming / completed (Wednesday 2026-10-21, 14:30)', () => {
  const now = { date: '2026-10-21', time: '14:30' };
  const timing = (fields) => getTiming({ status: 'Not Started', dueTime: '', ...fields }, now);

  test('completed assignments are never overdue or pending, however old', () => {
    assert.equal(timing({ status: 'Completed', dueDate: '2020-01-01' }), 'completed');
    assert.equal(timing({ status: 'Completed', dueDate: '2026-10-21', dueTime: '08:00' }), 'completed');
    assert.equal(timing({ status: 'Completed', dueDate: '2030-01-01' }), 'completed');
  });

  test('a past due date is overdue for every unfinished status', () => {
    assert.equal(timing({ dueDate: '2026-10-20' }), 'overdue');
    assert.equal(timing({ status: 'In Progress', dueDate: '2026-10-20' }), 'overdue');
    assert.equal(timing({ dueDate: '2026-09-01' }), 'overdue');
  });

  test('due today: overdue only once the due time has passed', () => {
    assert.equal(timing({ dueDate: '2026-10-21' }), 'dueSoon', 'no time given: still due today');
    assert.equal(timing({ dueDate: '2026-10-21', dueTime: '18:00' }), 'dueSoon');
    assert.equal(timing({ dueDate: '2026-10-21', dueTime: '14:30' }), 'dueSoon', 'exactly now is not yet late');
    assert.equal(timing({ dueDate: '2026-10-21', dueTime: '14:29' }), 'overdue');
    assert.equal(timing({ dueDate: '2026-10-21', dueTime: '00:00' }), 'overdue');
  });

  test('dueSoon covers today through 3 days ahead; later is upcoming', () => {
    assert.equal(timing({ dueDate: '2026-10-22' }), 'dueSoon');
    assert.equal(timing({ dueDate: '2026-10-24' }), 'dueSoon');
    assert.equal(timing({ dueDate: '2026-10-25' }), 'upcoming');
    assert.equal(timing({ dueDate: '2027-01-01' }), 'upcoming');
  });

  test('the month and year rollover is handled', () => {
    const lateOctober = { date: '2026-10-30', time: '10:00' };
    assert.equal(getTiming({ status: 'Not Started', dueTime: '', dueDate: '2026-11-02' }, lateOctober), 'dueSoon');
    assert.equal(getTiming({ status: 'Not Started', dueTime: '', dueDate: '2026-11-03' }, lateOctober), 'upcoming');
  });
});
