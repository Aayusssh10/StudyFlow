import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Assignment from '../src/models/Assignment.js';
import StudySession from '../src/models/StudySession.js';
import Subject from '../src/models/Subject.js';
import Task from '../src/models/Task.js';
import { MAX_EXPORT_ROWS } from '../src/controllers/reportController.js';
import { startApiTestServer, cleanupRunData, testName, testDbAvailable, RUN_TAG } from './helpers/apiTest.js';

const SKIP = testDbAvailable ? false : 'MONGODB_TEST_URI is not set in server/.env';
const NOW = '2026-10-21T14:30'; // Wednesday; its Monday-start week is 19-25 October

// A small RFC 4180 reader, so the tests check what a spreadsheet would read back (not just substrings).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

describe('Reports API (database: studyflow_test)', { skip: SKIP }, () => {
  let api;
  let maths;
  let history;

  before(async () => {
    api = await startApiTestServer();
    await Subject.init();
    await Assignment.init();
    await Task.init();
    await StudySession.init();
  });
  after(async () => {
    await cleanupRunData();
    await api.close();
  });
  beforeEach(async () => {
    await cleanupRunData();
    maths = (await api.call('POST', '/subjects', { name: testName('Maths'), color: '#2563eb' })).body.data;
    history = (await api.call('POST', '/subjects', { name: testName('History'), color: '#dc2626' })).body.data;
  });

  const summary = (query = '') => api.call('GET', `/reports/summary?now=${NOW}${query}`);
  const assignment = async (label, dueDate, fields = {}) => {
    const { status, body } = await api.call('POST', '/assignments', { title: testName(label), dueDate, subject: maths.id, ...fields });
    assert.equal(status, 201, JSON.stringify(body));
    return body.data;
  };
  const task = async (label, date, fields = {}) => {
    const { status, body } = await api.call('POST', '/tasks', { title: testName(label), date, ...fields });
    assert.equal(status, 201, JSON.stringify(body));
    return body.data;
  };
  let noteCounter = 0;
  const session = async (date, durationMinutes, fields = {}) => {
    noteCounter += 1;
    const { status, body } = await api.call('POST', '/study-sessions', { subject: maths.id, date, durationMinutes, notes: testName(`note ${noteCounter}`), ...fields });
    assert.equal(status, 201, JSON.stringify(body));
    return body.data;
  };

  // The known data every figure below is calculated from by hand.
  async function seed() {
    const a1 = await assignment('A1 done', '2026-10-05', { status: 'Completed' });
    await assignment('A2 done history', '2026-10-10', { status: 'Completed', subject: history.id });
    const a3 = await assignment('A3 overdue', '2026-10-20');
    await assignment('A4 soon', '2026-10-24', { status: 'In Progress' });
    await assignment('A5 later', '2026-11-15');
    await assignment('A6 september', '2026-09-30', { status: 'Completed' });

    await task('T1 done maths', '2026-10-21', { subject: maths.id, completed: true });
    await task('T2 today', '2026-10-21');
    await task('T3 via assignment', '2026-10-20', { assignment: a3.id });
    await task('T4 history', '2026-10-22', { subject: history.id });
    await task('T5 september', '2026-09-30', { completed: true });

    await session('2026-10-19', 60);
    await session('2026-10-20', 30);
    await session('2026-10-21', 45, { subject: history.id });
    await session('2026-10-25', 20);
    await session('2026-10-26', 15);
    await session('2026-09-30', 100);
    return { a1, a3 };
  }

  describe('summary: known data', () => {
    // A1 (5 Oct), A2 (10 Oct), A3 (20 Oct), A4 (24 Oct) are due in October; A5 is due 15 Nov and A6 on 30 Sep.
    test('October: assignment figures (counted by due date)', async () => {
      await seed();
      const { status, body } = await summary('&from=2026-10-01&to=2026-10-31');
      assert.equal(status, 200);
      assert.deepEqual(body.data.assignments, {
        total: 4, completed: 2, pending: 2, overdue: 1, dueSoon: 1, completionPercent: 50,
        statusDistribution: [{ status: 'Not Started', count: 1 }, { status: 'In Progress', count: 1 }, { status: 'Completed', count: 2 }],
      });
      assert.deepEqual(body.data.filter, { from: '2026-10-01', to: '2026-10-31', subject: null, weekStart: 'monday' });
    });

    test('October: task figures (counted by their day)', async () => {
      await seed();
      const { tasks } = (await summary('&from=2026-10-01&to=2026-10-31')).body.data;
      assert.deepEqual(tasks, { total: 4, completed: 1, pending: 3, overdue: 1, completionPercent: 25 });
    });

    test('October: study time, by day, by week and by subject', async () => {
      await seed();
      const { study } = (await summary('&from=2026-10-01&to=2026-10-31')).body.data;
      assert.equal(study.totalMinutes, 170);
      assert.equal(study.sessionCount, 5);
      assert.equal(study.activeDays, 5);
      assert.equal(study.averageMinutesPerActiveDay, 34);
      assert.deepEqual(study.byDay.map((d) => [d.date, d.minutes]), [['2026-10-19', 60], ['2026-10-20', 30], ['2026-10-21', 45], ['2026-10-25', 20], ['2026-10-26', 15]]);
      assert.deepEqual(study.byWeek, [
        { weekStart: '2026-10-19', weekEnd: '2026-10-25', minutes: 155, sessions: 4 },
        { weekStart: '2026-10-26', weekEnd: '2026-11-01', minutes: 15, sessions: 1 },
      ]);
      assert.deepEqual(study.bySubject.map((s) => [s.subject.name, s.minutes, s.sessions]), [[maths.name, 125, 4], [history.name, 45, 1]]);
    });

    test('week start Sunday regroups the same sessions into Sunday-Saturday weeks', async () => {
      await seed();
      const { study, filter } = (await summary('&from=2026-10-01&to=2026-10-31&weekStart=sunday')).body.data;
      assert.equal(filter.weekStart, 'sunday');
      assert.equal(study.totalMinutes, 170, 'the total never depends on the week start');
      assert.deepEqual(study.byWeek, [
        { weekStart: '2026-10-18', weekEnd: '2026-10-24', minutes: 135, sessions: 3 },
        { weekStart: '2026-10-25', weekEnd: '2026-10-31', minutes: 35, sessions: 2 },
      ]);
    });

    test('all time: no from / to', async () => {
      await seed();
      const { assignments, tasks, study } = (await summary()).body.data;
      assert.equal(assignments.total, 6);
      assert.equal(assignments.completed, 3);
      assert.equal(assignments.completionPercent, 50);
      assert.equal(tasks.total, 5);
      assert.equal(tasks.completionPercent, 40);
      assert.equal(study.totalMinutes, 270);
      assert.equal(study.sessionCount, 6);
    });

    test('a range open at one end', async () => {
      await seed();
      assert.equal((await summary('&from=2026-10-21')).body.data.study.totalMinutes, 80, 'from 21 Oct on: 45 + 20 + 15');
      assert.equal((await summary('&to=2026-10-19')).body.data.study.totalMinutes, 160, 'up to 19 Oct: 60 + 100');
    });

    test('a single day, and the boundary days are included', async () => {
      await seed();
      const day = (await summary('&from=2026-10-21&to=2026-10-21')).body.data;
      assert.equal(day.study.totalMinutes, 45);
      assert.equal(day.tasks.total, 2);
      assert.equal(day.assignments.total, 0);
      const edges = (await summary('&from=2026-10-19&to=2026-10-26')).body.data.study;
      assert.equal(edges.totalMinutes, 170, 'both the first and the last day are inside the range');
    });

    test('a subject filter applies to assignments, tasks (directly or through their assignment) and sessions', async () => {
      await seed();
      const { assignments, tasks, study } = (await summary(`&from=2026-10-01&to=2026-10-31&subject=${maths.id}`)).body.data;
      assert.equal(assignments.total, 3, 'A1, A3 and A4 (A2 is History)');
      assert.equal(assignments.completed, 1);
      assert.equal(assignments.completionPercent, 33);
      assert.equal(tasks.total, 2, 'T1 (direct) and T3 (through its assignment)');
      assert.equal(tasks.completionPercent, 50);
      assert.equal(study.totalMinutes, 125);
      assert.equal(study.bySubject.length, 1);
      const other = (await summary(`&from=2026-10-01&to=2026-10-31&subject=${history.id}`)).body.data;
      assert.equal(other.assignments.total, 1);
      assert.equal(other.tasks.total, 1);
      assert.equal(other.study.totalMinutes, 45);
    });

    test('consistent with the other pages', async () => {
      await seed();
      const { assignments, study } = (await summary('&from=2026-10-01&to=2026-10-31')).body.data;
      const listed = (await api.call('GET', `/assignments?dueFrom=2026-10-01&dueTo=2026-10-31&now=${NOW}&limit=1`)).body.meta.total;
      const overdue = (await api.call('GET', `/assignments?dueFrom=2026-10-01&dueTo=2026-10-31&timing=overdue&now=${NOW}&limit=1`)).body.meta.total;
      assert.equal(assignments.total, listed);
      assert.equal(assignments.overdue, overdue);
      const sessions = (await api.call('GET', '/study-sessions/summary?dateFrom=2026-10-01&dateTo=2026-10-31')).body.data;
      assert.equal(study.totalMinutes, sessions.totalMinutes);
      assert.equal(study.sessionCount, sessions.sessionCount);
    });

    test('the figures follow changes: complete, delete, move', async () => {
      const { a3 } = await seed();
      assert.equal((await api.call('PATCH', `/assignments/${a3.id}/status`, { status: 'Completed' })).status, 200);
      const after = (await summary('&from=2026-10-01&to=2026-10-31')).body.data.assignments;
      assert.deepEqual([after.completed, after.overdue, after.completionPercent], [3, 0, 75]);
    });

    test('the "now" clock decides overdue and due soon', async () => {
      await seed();
      const later = await api.call('GET', '/reports/summary?now=2026-11-20T09:00&from=2026-10-01&to=2026-11-30');
      assert.equal(later.body.data.assignments.overdue, 3, 'A3, A4 and A5 are all past due by 20 Nov');
      assert.equal(later.body.data.assignments.dueSoon, 0);
    });
  });

  describe('summary: empty data is never shown as 0% or NaN', () => {
    test('with no records at all: zeros, null percentages and averages, empty lists', async () => {
      const { status, body } = await summary();
      assert.equal(status, 200);
      const d = body.data;
      assert.deepEqual(d.assignments, {
        total: 0, completed: 0, pending: 0, overdue: 0, dueSoon: 0, completionPercent: null,
        statusDistribution: [{ status: 'Not Started', count: 0 }, { status: 'In Progress', count: 0 }, { status: 'Completed', count: 0 }],
      });
      assert.deepEqual(d.tasks, { total: 0, completed: 0, pending: 0, overdue: 0, completionPercent: null });
      assert.deepEqual(d.study, { totalMinutes: 0, sessionCount: 0, activeDays: 0, averageMinutesPerActiveDay: null, byDay: [], byWeek: [], bySubject: [] });
      assert.equal(JSON.stringify(d).includes('NaN'), false);
    });

    test('a period or subject with nothing in it behaves the same, even when other data exists', async () => {
      await seed();
      const empty = (await summary('&from=2030-01-01&to=2030-01-31')).body.data;
      assert.equal(empty.assignments.completionPercent, null);
      assert.equal(empty.tasks.completionPercent, null);
      assert.equal(empty.study.averageMinutesPerActiveDay, null);
      const ghost = await summary('&subject=64b7f0c2a1b2c3d4e5f60718');
      assert.equal(ghost.status, 200, 'a well-formed id that does not exist is just an empty result');
      assert.equal(ghost.body.data.assignments.total, 0);
    });

    test('0% is shown only when there is data and none of it is complete', async () => {
      await assignment('open one', '2026-10-30');
      assert.equal((await summary()).body.data.assignments.completionPercent, 0);
    });

    test('percentages are whole numbers rounded to the nearest', async () => {
      await assignment('c1', '2026-10-01', { status: 'Completed' });
      await assignment('p1', '2026-10-02');
      await assignment('p2', '2026-10-03');
      assert.equal((await summary()).body.data.assignments.completionPercent, 33, '1 of 3');
      await assignment('c2', '2026-10-04', { status: 'Completed' });
      await assignment('c3', '2026-10-05', { status: 'Completed' });
      await assignment('p3', '2026-10-06');
      await assignment('p4', '2026-10-07');
      assert.equal((await summary()).body.data.assignments.completionPercent, 43, '3 of 7 = 42.86');
    });
  });

  describe('summary: damaged data and invalid input', () => {
    test('records whose subject no longer exists still count', async () => {
      const db = mongoose.connection;
      const stamp = { createdAt: new Date(), updatedAt: new Date() };
      await db.collection('studysessions').insertOne({ subject: new mongoose.Types.ObjectId(), assignment: null, date: '2026-10-21', startTime: '', durationMinutes: 35, notes: testName('ghost'), type: '', ...stamp });
      const { status, body } = await summary();
      assert.equal(status, 200);
      assert.equal(body.data.study.totalMinutes, 35);
      assert.equal(body.data.study.bySubject[0].subject, null);
    });

    test('bad input is a 400 with a message', async () => {
      for (const query of ['&from=2026-02-30', '&to=abc', '&from=2026-10-31&to=2026-10-01', '&subject=abc', '&weekStart=friday', '&from=2026-10-01&from=2026-10-02']) {
        const { status, body } = await summary(query);
        assert.equal(status, 400, query);
        assert.equal(body.success, false);
      }
      assert.equal((await api.call('GET', '/reports/summary?now=tomorrow')).status, 400);
    });

    test('operator-style keys are ignored, never executed', async () => {
      await seed();
      const { status, body } = await summary('&subject[$ne]=x&from[$gt]=2026-01-01');
      assert.equal(status, 200);
      assert.equal(body.data.assignments.total, 6, 'the unknown keys changed nothing');
    });

    test('only GET exists', async () => {
      assert.equal((await api.call('POST', '/reports/summary', {})).status, 404);
      assert.equal((await api.call('DELETE', '/reports/summary')).status, 404);
    });
  });

  describe('CSV export', () => {
    const exportCsv = async (query) => {
      const response = await fetch(`${api.baseUrl}/api/reports/export?now=${NOW}&${query}`);
      // read the raw bytes: fetch's text() would silently drop the byte-order mark we want to check
      return { response, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer()) };
    };
    const rowsOf = async (query) => {
      const { response, text } = await exportCsv(query);
      assert.equal(response.status, 200, text);
      assert.equal(text.charCodeAt(0), 0xfeff, 'a byte-order mark for Excel');
      return parseCsv(text.slice(1));
    };

    test('assignments: headers, one row per assignment in due-date order, and the file name', async () => {
      await seed();
      const { response, text } = await exportCsv('type=assignments&from=2026-10-01&to=2026-10-31');
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/csv; charset=utf-8/);
      assert.equal(response.headers.get('content-disposition'), 'attachment; filename="studyflow-assignments-2026-10-21.csv"');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok(text.includes('\r\n'), 'rows end with CRLF');
      assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'no bare line feeds outside quoted cells');
      const rows = parseCsv(text.slice(1));
      assert.deepEqual(rows[0], ['Title', 'Subject', 'Type', 'Priority', 'Status', 'Due date', 'Due time', 'Estimated minutes', 'Deadline', 'Description']);
      assert.equal(rows.length, 1 + 4);
      assert.deepEqual(rows.slice(1).map((r) => r[5]), ['2026-10-05', '2026-10-10', '2026-10-20', '2026-10-24']);
      assert.deepEqual(rows.slice(1).map((r) => r[8]), ['completed', 'completed', 'overdue', 'dueSoon']);
      assert.equal(rows[1][1], maths.name);
      assert.equal(rows[2][1], history.name);
    });

    test('tasks: done flag, timing, and the subject of a linked assignment', async () => {
      await seed();
      const rows = await rowsOf('type=tasks&from=2026-10-01&to=2026-10-31');
      assert.deepEqual(rows[0], ['Title', 'Date', 'Time', 'Priority', 'Done', 'Subject', 'Assignment', 'Timing', 'Description']);
      assert.equal(rows.length, 1 + 4);
      const byTitle = Object.fromEntries(rows.slice(1).map((r) => [r[0].replace(`${RUN_TAG}_`, ''), r]));
      assert.equal(byTitle['T1 done maths'][4], 'Yes');
      assert.equal(byTitle['T2 today'][4], 'No');
      assert.equal(byTitle['T3 via assignment'][5], maths.name, "a linked task shows its assignment's subject");
      assert.equal(byTitle['T3 via assignment'][6], testName('A3 overdue'));
      assert.equal(byTitle['T3 via assignment'][7], 'overdue');
      assert.equal(byTitle['T2 today'][5], '');
    });

    test('study sessions: durations are numbers and add up to the report total', async () => {
      await seed();
      const rows = await rowsOf('type=study-sessions&from=2026-10-01&to=2026-10-31');
      assert.deepEqual(rows[0], ['Date', 'Start time', 'Duration (minutes)', 'Subject', 'Assignment', 'Type', 'Notes']);
      assert.equal(rows.length, 1 + 5);
      const total = rows.slice(1).reduce((sum, r) => sum + Number(r[2]), 0);
      assert.equal(total, (await summary('&from=2026-10-01&to=2026-10-31')).body.data.study.totalMinutes);
      assert.deepEqual(rows.slice(1).map((r) => r[0]), ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-25', '2026-10-26']);
    });

    test('row counts equal the summary counts, with and without a subject filter', async () => {
      await seed();
      const all = (await summary()).body.data;
      assert.equal((await rowsOf('type=assignments')).length - 1, all.assignments.total);
      assert.equal((await rowsOf('type=tasks')).length - 1, all.tasks.total);
      assert.equal((await rowsOf('type=study-sessions')).length - 1, all.study.sessionCount);
      const m = (await summary(`&subject=${maths.id}`)).body.data;
      assert.equal((await rowsOf(`type=tasks&subject=${maths.id}`)).length - 1, m.tasks.total);
      assert.equal((await rowsOf(`type=assignments&subject=${history.id}`)).length - 1, 1);
    });

    test('an empty export is just the header row (no error)', async () => {
      const rows = await rowsOf('type=assignments');
      assert.equal(rows.length, 1);
      assert.equal(rows[0][0], 'Title');
    });

    test('hostile and awkward text comes back exactly as stored, formulas neutralized', async () => {
      const awkward = [
        'plain',
        'comma, inside',
        'quote " inside',
        'two\nlines',
        'windows\r\nlines',
        '=HYPERLINK("http://evil.example","click")',
        '+1+1',
        '-2+3',
        '@SUM(1+1)',
        'Zoë 学习 📚',
        'ends with comma,',
        '"starts with quote',
      ];
      for (const [i, description] of awkward.entries()) await assignment(`awkward ${String(i).padStart(2, '0')}`, '2026-10-22', { description });
      const rows = await rowsOf('type=assignments');
      assert.equal(rows.length, 1 + awkward.length);
      const sorted = rows.slice(1).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [i, expected] of awkward.entries()) {
        const stored = expected.trim(); // the API trims descriptions
        const wanted = /^[=+\-@]/.test(stored) ? `'${stored}` : stored;
        assert.equal(sorted[i][9], wanted, `description ${i}: ${JSON.stringify(expected)}`);
        assert.equal(sorted[i].length, 10, 'every row has exactly 10 cells, so nothing broke the columns');
      }
    });

    test('too many rows is refused with a clear message', { timeout: 120000 }, async () => {
      const db = mongoose.connection;
      const stamp = { createdAt: new Date(), updatedAt: new Date() };
      const docs = Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_, i) => ({
        subject: new mongoose.Types.ObjectId(maths.id), assignment: null, date: '2026-10-21', startTime: '', durationMinutes: 1, notes: `${RUN_TAG}_bulk ${i}`, type: '', ...stamp,
      }));
      await db.collection('studysessions').insertMany(docs, { ordered: false });
      const { response, text } = await exportCsv('type=study-sessions');
      assert.equal(response.status, 400);
      assert.match(JSON.parse(text).error.message, /more than 10000 rows/);
      const narrowed = await exportCsv('type=study-sessions&from=2030-01-01&to=2030-01-31');
      assert.equal(narrowed.response.status, 200, 'a narrower range works');
    });

    test('bad input is a JSON 400 (not a half-built file)', async () => {
      for (const query of ['', 'type=sessions', 'type=tasks&type=assignments', 'type=tasks&from=2026-13-01', 'type=tasks&from=2026-10-31&to=2026-10-01', 'type=tasks&subject=abc']) {
        const { response, text } = await exportCsv(query);
        assert.equal(response.status, 400, query);
        assert.match(response.headers.get('content-type'), /json/);
        assert.equal(JSON.parse(text).success, false);
        assert.equal(response.headers.get('content-disposition'), null, 'no download is offered for an error');
      }
    });
  });

  describe('dashboard week start', () => {
    test('the dashboard "this week" follows weekStart, and rejects bad values', async () => {
      await session('2026-10-18', 20); // Sunday
      await session('2026-10-19', 45); // Monday
      const monday = (await api.call('GET', `/dashboard/stats?now=${NOW}`)).body.data.counts.study;
      assert.deepEqual([monday.week, monday.weekMinutes], [{ from: '2026-10-19', to: '2026-10-25' }, 45]);
      const sunday = (await api.call('GET', `/dashboard/stats?now=${NOW}&weekStart=sunday`)).body.data.counts.study;
      assert.deepEqual([sunday.week, sunday.weekMinutes], [{ from: '2026-10-18', to: '2026-10-24' }, 65]);
      assert.equal((await api.call('GET', `/dashboard/stats?now=${NOW}&weekStart=friday`)).status, 400);
    });
  });
});
