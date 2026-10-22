import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Assignment from '../src/models/Assignment.js';
import StudySession from '../src/models/StudySession.js';
import Subject from '../src/models/Subject.js';
import Task from '../src/models/Task.js';
import { startApiTestServer, cleanupRunData, testName, testDbAvailable, RUN_TAG } from './helpers/apiTest.js';

const SKIP = testDbAvailable ? false : 'MONGODB_TEST_URI is not set in server/.env';

// The user's clock for every request below: Wednesday 21 October 2026, 14:30. Its Monday-to-Sunday week is 19-25 October.
const NOW = '2026-10-21T14:30';
const stats = (api, now = NOW) => api.call('GET', `/dashboard/stats?now=${now}`);

describe('Dashboard API (database: studyflow_test)', { skip: SKIP }, () => {
  let api;
  let maths;

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
  });

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
  const session = async (label, date, durationMinutes, fields = {}) => {
    const { status, body } = await api.call('POST', '/study-sessions', {
      subject: maths.id, date, durationMinutes, notes: testName(label), ...fields,
    });
    assert.equal(status, 201, JSON.stringify(body));
    return body.data;
  };

  // The same data as a fixed scenario (see the comments for the figures it must produce).
  async function seedScenario() {
    const a = {
      overdue: await assignment('A overdue', '2026-10-20'),
      overdueTime: await assignment('A overdue by time', '2026-10-21', { dueTime: '13:00', status: 'In Progress' }),
      laterToday: await assignment('A later today', '2026-10-21', { dueTime: '15:00' }),
      soon: await assignment('A due in 3 days', '2026-10-24'),
      upcoming: await assignment('A due in 4 days', '2026-10-25'),
      done: await assignment('A completed', '2026-10-01', { status: 'Completed' }),
    };
    const t = {
      noTime: await task('T today no time', '2026-10-21'),
      past: await task('T today 14:00', '2026-10-21', { time: '14:00' }),
      done: await task('T today done', '2026-10-21', { time: '16:00', completed: true }),
      yesterday: await task('T yesterday', '2026-10-20'),
      tomorrow: await task('T tomorrow', '2026-10-22'),
    };
    const s = {
      today1: await session('S today 14:00', '2026-10-21', 60, { startTime: '14:00' }),
      today2: await session('S today no time', '2026-10-21', 30),
      monday: await session('S monday', '2026-10-19', 45),
      sundayBefore: await session('S sunday before', '2026-10-18', 20),
      sundayEnd: await session('S sunday end of week', '2026-10-25', 10),
      old: await session('S old', '2026-10-14', 100),
    };
    return { a, t, s };
  }

  describe('an empty database', () => {
    test('returns zeros, empty lists and a zero-filled 7-day chart (not errors)', async () => {
      const { status, body } = await stats(api);
      assert.equal(status, 200);
      const d = body.data;
      assert.equal(d.counts.subjects, 1, 'only the subject made by beforeEach');
      assert.deepEqual(d.counts.assignments, { total: 0, pending: 0, completed: 0, overdue: 0, dueSoon: 0 });
      assert.deepEqual(d.counts.tasks, { today: 0, todayDone: 0, overdue: 0 });
      assert.deepEqual(d.counts.study, { todayMinutes: 0, weekMinutes: 0, totalMinutes: 0, sessionCount: 0, week: { from: '2026-10-19', to: '2026-10-25' } });
      assert.deepEqual(d.today, { tasks: [], sessions: [] });
      assert.deepEqual(d.upcomingDeadlines, []);
      assert.deepEqual(d.recentActivity, []);
      assert.deepEqual(d.assignmentStatus, [
        { status: 'Not Started', count: 0 }, { status: 'In Progress', count: 0 }, { status: 'Completed', count: 0 },
      ]);
      assert.equal(d.studyLast7Days.length, 7);
      assert.ok(d.studyLast7Days.every((day) => day.minutes === 0));
      assert.deepEqual(d.studyLast7Days.map((day) => day.date), [
        '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21',
      ]);
    });
  });

  describe('figures', () => {
    test('assignment counts follow the overdue / due-soon / completed rules, and every assignment is in exactly one group', async () => {
      await seedScenario();
      const { counts } = (await stats(api)).body.data;
      assert.deepEqual(counts.assignments, { total: 6, pending: 5, completed: 1, overdue: 2, dueSoon: 2 });
      // overdue (2) + dueSoon (2) + upcoming (1) + completed (1) = 6: nothing counted twice or lost
      assert.equal(counts.assignments.overdue + counts.assignments.dueSoon + 1 + counts.assignments.completed, counts.assignments.total);
    });

    test('a completed assignment is never overdue or due soon, however old or close its date', async () => {
      await assignment('done long ago', '2026-01-01', { status: 'Completed' });
      await assignment('done today', '2026-10-21', { status: 'Completed' });
      const { counts, upcomingDeadlines } = (await stats(api)).body.data;
      assert.deepEqual(counts.assignments, { total: 2, pending: 0, completed: 2, overdue: 0, dueSoon: 0 });
      assert.deepEqual(upcomingDeadlines, []);
    });

    test('due-soon boundary: today and +3 days are due soon, +4 days is upcoming', async () => {
      await assignment('plus 3', '2026-10-24');
      await assignment('plus 4', '2026-10-25');
      assert.equal((await stats(api)).body.data.counts.assignments.dueSoon, 1);
      // a day later, the +4 assignment has moved to +3 and is now due soon too
      assert.equal((await stats(api, '2026-10-22T09:00')).body.data.counts.assignments.dueSoon, 2);
    });

    test('an assignment due today flips from due soon to overdue when its time passes', async () => {
      await assignment('due 15:00', '2026-10-21', { dueTime: '15:00' });
      assert.deepEqual(
        [(await stats(api, '2026-10-21T14:59')).body.data.counts.assignments.dueSoon, (await stats(api, '2026-10-21T14:59')).body.data.counts.assignments.overdue],
        [1, 0],
      );
      const after = (await stats(api, '2026-10-21T15:01')).body.data.counts.assignments;
      assert.equal(after.dueSoon, 0);
      assert.equal(after.overdue, 1);
      // exactly at the due time it is not yet overdue (the same rule the Assignments page uses)
      assert.equal((await stats(api, '2026-10-21T15:00')).body.data.counts.assignments.overdue, 0);
    });

    test('task counts: planned today, done today, overdue (earlier days, or earlier today); completed tasks are never overdue', async () => {
      await seedScenario();
      const { counts } = (await stats(api)).body.data;
      assert.deepEqual(counts.tasks, { today: 3, todayDone: 1, overdue: 2 });
      await task('done and old', '2026-01-01', { completed: true });
      assert.equal((await stats(api)).body.data.counts.tasks.overdue, 2);
    });

    test('study minutes: today, this week (Monday-Sunday), all time, session count', async () => {
      await seedScenario();
      const { study } = (await stats(api)).body.data.counts;
      assert.equal(study.todayMinutes, 90);
      assert.equal(study.weekMinutes, 145, '19 Oct (45) + 21 Oct (60+30) + 25 Oct (10); 18 Oct (Sunday before) is outside');
      assert.equal(study.totalMinutes, 265);
      assert.equal(study.sessionCount, 6);
      assert.deepEqual(study.week, { from: '2026-10-19', to: '2026-10-25' });
    });

    test('week edges: on a Monday the week starts that day; on a Sunday it ends that day', async () => {
      await session('sunday before', '2026-10-18', 20);
      await session('monday', '2026-10-19', 45);
      await session('sunday', '2026-10-25', 10);
      await session('next monday', '2026-10-26', 5);
      const monday = (await stats(api, '2026-10-19T08:00')).body.data.counts.study;
      assert.deepEqual([monday.week, monday.weekMinutes], [{ from: '2026-10-19', to: '2026-10-25' }, 55]);
      const sunday = (await stats(api, '2026-10-25T23:59')).body.data.counts.study;
      assert.deepEqual([sunday.week, sunday.weekMinutes], [{ from: '2026-10-19', to: '2026-10-25' }, 55]);
      const nextMonday = (await stats(api, '2026-10-26T00:00')).body.data.counts.study;
      assert.deepEqual([nextMonday.week, nextMonday.weekMinutes], [{ from: '2026-10-26', to: '2026-11-01' }, 5]);
    });

    test('month and year edges for the weekly range and the 7-day chart', async () => {
      await session('new years eve', '2026-12-31', 15);
      await session('new years day', '2027-01-01', 25);
      const { counts, studyLast7Days } = (await stats(api, '2027-01-01T10:00')).body.data;
      assert.deepEqual(counts.study.week, { from: '2026-12-28', to: '2027-01-03' });
      assert.equal(counts.study.weekMinutes, 40);
      assert.deepEqual(studyLast7Days.map((d) => d.date), [
        '2026-12-26', '2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01',
      ]);
      assert.deepEqual(studyLast7Days.slice(-2).map((d) => d.minutes), [15, 25]);
    });

    test('leap day: 2028-02-29 exists in the chart and the week range', async () => {
      await session('leap day', '2028-02-29', 40);
      const { counts, studyLast7Days } = (await stats(api, '2028-03-01T08:00')).body.data;
      assert.equal(studyLast7Days.at(-2).date, '2028-02-29');
      assert.equal(studyLast7Days.at(-2).minutes, 40);
      assert.deepEqual(counts.study.week, { from: '2028-02-28', to: '2028-03-05' });
    });

    test('the 7-day chart covers today and the 6 days before; future and older sessions are not in it', async () => {
      await seedScenario();
      const { studyLast7Days } = (await stats(api)).body.data;
      assert.deepEqual(
        studyLast7Days.map((d) => [d.date, d.minutes]),
        [['2026-10-15', 0], ['2026-10-16', 0], ['2026-10-17', 0], ['2026-10-18', 20], ['2026-10-19', 45], ['2026-10-20', 0], ['2026-10-21', 90]],
      );
    });

    test('status distribution counts each assignment once', async () => {
      await seedScenario();
      const { assignmentStatus } = (await stats(api)).body.data;
      assert.deepEqual(assignmentStatus, [
        { status: 'Not Started', count: 4 }, { status: 'In Progress', count: 1 }, { status: 'Completed', count: 1 },
      ]);
    });
  });

  describe('lists', () => {
    test('upcoming deadlines: only pending assignments, earliest first, with their timing and subject', async () => {
      const { a } = await seedScenario();
      const { upcomingDeadlines } = (await stats(api)).body.data;
      assert.deepEqual(upcomingDeadlines.map((d) => d.id), [a.overdue.id, a.overdueTime.id, a.laterToday.id, a.soon.id, a.upcoming.id]);
      assert.deepEqual(upcomingDeadlines.map((d) => d.timing), ['overdue', 'overdue', 'dueSoon', 'dueSoon', 'upcoming']);
      assert.equal(upcomingDeadlines[0].subject.name, maths.name);
      assert.equal(upcomingDeadlines.some((d) => d.id === a.done.id), false);
    });

    test('upcoming deadlines are limited to 8', async () => {
      for (let i = 0; i < 10; i += 1) await assignment(`bulk ${i}`, `2026-11-${String(10 + i).padStart(2, '0')}`);
      const { upcomingDeadlines, counts } = (await stats(api)).body.data;
      assert.equal(upcomingDeadlines.length, 8);
      assert.equal(counts.assignments.pending, 10, 'the count is the real total, not the shortened list');
      assert.equal(upcomingDeadlines[0].dueDate, '2026-11-10');
    });

    test("today's tasks are only today's, ordered by time (untimed last), with their timing", async () => {
      const { t } = await seedScenario();
      const { today } = (await stats(api)).body.data;
      assert.deepEqual(today.tasks.map((x) => x.id), [t.past.id, t.done.id, t.noTime.id]);
      assert.deepEqual(today.tasks.map((x) => x.timing), ['overdue', 'completed', 'today']);
    });

    test("today's sessions are only today's, ordered by start time", async () => {
      const { s } = await seedScenario();
      const { today } = (await stats(api)).body.data;
      assert.equal(today.sessions.length, 2);
      assert.deepEqual(today.sessions.map((x) => x.id).sort(), [s.today1.id, s.today2.id].sort());
      assert.equal(today.sessions[0].startTime === '' || today.sessions[0].startTime <= today.sessions[1].startTime, true);
    });

    test('a task linked to an assignment shows that assignment and its subject', async () => {
      const linked = await assignment('linked', '2026-10-30');
      const t = await api.call('POST', '/tasks', { title: testName('via assignment'), date: '2026-10-21', assignment: linked.id });
      assert.equal(t.status, 201);
      const { today } = (await stats(api)).body.data;
      assert.equal(today.tasks[0].assignment.title, linked.title);
      assert.equal(today.tasks[0].assignment.subject.name, maths.name);
    });

    test('recent activity: newest first, at most 8, added vs updated, across all three kinds', async () => {
      const { a } = await seedScenario();
      let { recentActivity } = (await stats(api)).body.data;
      assert.equal(recentActivity.length, 8);
      assert.equal(recentActivity[0].type, 'session', 'the last thing created was a session');
      assert.ok(recentActivity.every((item) => item.action === 'added'));
      const times = recentActivity.map((item) => Date.parse(item.at));
      assert.deepEqual([...times].sort((x, y) => y - x), times, 'newest first');

      assert.equal((await api.call('PATCH', `/assignments/${a.soon.id}/status`, { status: 'In Progress' })).status, 200);
      ({ recentActivity } = (await stats(api)).body.data);
      assert.equal(recentActivity[0].id, a.soon.id);
      assert.equal(recentActivity[0].type, 'assignment');
      assert.equal(recentActivity[0].action, 'updated');
      assert.equal(recentActivity.length, 8);
    });
  });

  test('linking a task or session to an assignment does not make the assignment look "updated"', async () => {
    const linked = await assignment('quietly linked', '2026-10-30');
    await api.call('POST', '/tasks', { title: testName('points at it'), date: '2026-10-21', assignment: linked.id });
    await session('points at it too', '2026-10-21', 20, { assignment: linked.id });
    const { recentActivity } = (await stats(api)).body.data;
    const item = recentActivity.find((entry) => entry.id === linked.id);
    assert.equal(item.action, 'added');
  });

  describe('stays consistent with the pages', () => {
    test('every figure equals what the list and summary endpoints report for the same clock', async () => {
      await seedScenario();
      const { counts } = (await stats(api)).body.data;
      const total = async (path) => (await api.call('GET', `${path}${path.includes('?') ? '&' : '?'}now=${NOW}&limit=1`)).body.meta.total;
      assert.equal(await total('/assignments'), counts.assignments.total);
      assert.equal(await total('/assignments?timing=overdue'), counts.assignments.overdue);
      assert.equal(await total('/assignments?timing=dueSoon'), counts.assignments.dueSoon);
      assert.equal(await total('/assignments?timing=completed'), counts.assignments.completed);
      assert.equal(await total('/tasks?timing=overdue'), counts.tasks.overdue);
      assert.equal(await total('/tasks?date=2026-10-21'), counts.tasks.today);
      const week = (await api.call('GET', '/study-sessions/summary?dateFrom=2026-10-19&dateTo=2026-10-25')).body.data;
      const day = (await api.call('GET', '/study-sessions/summary?date=2026-10-21')).body.data;
      const all = (await api.call('GET', '/study-sessions/summary')).body.data;
      assert.equal(week.totalMinutes, counts.study.weekMinutes);
      assert.equal(day.totalMinutes, counts.study.todayMinutes);
      assert.equal(all.totalMinutes, counts.study.totalMinutes);
      assert.equal(all.sessionCount, counts.study.sessionCount);
    });

    test('figures match totals computed independently straight from the stored records', async () => {
      await seedScenario();
      const db = mongoose.connection;
      const stored = await db.collection('studysessions').find({ notes: { $regex: `^${RUN_TAG}_` } }).toArray();
      const expectedTotal = stored.reduce((sum, row) => sum + row.durationMinutes, 0);
      const expectedToday = stored.filter((row) => row.date === '2026-10-21').reduce((sum, row) => sum + row.durationMinutes, 0);
      const { study } = (await stats(api)).body.data.counts;
      assert.equal(study.totalMinutes, expectedTotal);
      assert.equal(study.todayMinutes, expectedToday);
      assert.equal(study.sessionCount, stored.length);
    });

    test('changes show up immediately: complete, edit, delete', async () => {
      const { a, t, s } = await seedScenario();
      assert.equal((await api.call('PATCH', `/assignments/${a.overdue.id}/status`, { status: 'Completed' })).status, 200);
      assert.equal((await api.call('PATCH', `/tasks/${t.noTime.id}/completed`, { completed: true })).status, 200);
      assert.equal((await api.call('DELETE', `/study-sessions/${s.today1.id}`)).status, 200);
      const { counts } = (await stats(api)).body.data;
      assert.equal(counts.assignments.overdue, 1);
      assert.equal(counts.assignments.completed, 2);
      assert.equal(counts.tasks.todayDone, 2);
      assert.equal(counts.study.todayMinutes, 30);
      assert.equal(counts.study.sessionCount, 5);
    });

    test('deleting an assignment removes it from the deadlines but keeps its sessions (unlinked) in the totals', async () => {
      const linked = await assignment('to delete', '2026-10-22');
      await session('linked session', '2026-10-21', 50, { assignment: linked.id });
      assert.equal((await api.call('DELETE', `/assignments/${linked.id}`)).status, 200);
      const d = (await stats(api)).body.data;
      assert.equal(d.counts.assignments.total, 0);
      assert.equal(d.counts.study.todayMinutes, 50);
      assert.equal(d.today.sessions[0].assignment, null);
    });

    test('a subject that still has records cannot be deleted, so the dashboard never loses their subject', async () => {
      await assignment('keeps subject', '2026-10-22');
      assert.equal((await api.call('DELETE', `/subjects/${maths.id}`)).status, 409);
      assert.equal((await stats(api)).body.data.counts.subjects, 1);
    });
  });

  describe('damaged data (made outside the app) does not crash the dashboard', () => {
    test('records whose subject or assignment no longer exists still load', async () => {
      const db = mongoose.connection;
      const ghost = new mongoose.Types.ObjectId();
      await db.collection('assignments').insertOne({
        title: testName('ghost subject'), dueDate: '2026-10-22', dueTime: '', priority: 'Medium', priorityRank: 2, status: 'Not Started',
        estimatedMinutes: null, type: '', description: '', subject: ghost, createdAt: new Date(), updatedAt: new Date(),
      });
      await db.collection('tasks').insertOne({
        title: testName('ghost links'), description: '', date: '2026-10-21', time: '', priority: 'Medium', priorityRank: 2, timeSort: '99:99',
        completed: false, subject: ghost, assignment: new mongoose.Types.ObjectId(), createdAt: new Date(), updatedAt: new Date(),
      });
      await db.collection('studysessions').insertOne({
        subject: ghost, assignment: null, date: '2026-10-21', startTime: '', durationMinutes: 35, notes: testName('ghost session'), type: '',
        createdAt: new Date(), updatedAt: new Date(),
      });
      const { status, body } = await stats(api);
      assert.equal(status, 200);
      assert.equal(body.data.counts.study.todayMinutes, 35, 'the minutes still count');
      assert.equal(body.data.upcomingDeadlines[0].subject, null);
      assert.equal(body.data.today.tasks[0].subject, null);
      assert.equal(body.data.today.tasks[0].assignment, null);
      assert.ok(body.data.recentActivity.some((item) => item.type === 'session' && item.title === 'Unknown subject'));
    });
  });

  describe('invalid input', () => {
    test('"now" must be a real local date and time', async () => {
      for (const bad of ['abc', '2026-10-21', '2026-13-01T10:00', '2026-02-30T10:00', '2026-10-21T25:00', '2026-10-21T10:60', '2026-10-21 14:30']) {
        const { status, body } = await api.call('GET', `/dashboard/stats?now=${encodeURIComponent(bad)}`);
        assert.equal(status, 400, bad);
        assert.equal(body.success, false);
      }
    });

    test('without "now" the computer\'s own clock is used', async () => {
      const { status, body } = await api.call('GET', '/dashboard/stats');
      assert.equal(status, 200);
      assert.match(body.data.now.date, /^\d{4}-\d{2}-\d{2}$/);
    });

    test('repeated "now" is rejected; an operator-style key is just an unknown parameter and is never executed', async () => {
      assert.equal((await api.call('GET', `/dashboard/stats?now=${NOW}&now=${NOW}`)).status, 400);
      // Express reads "now[$ne]" as a plain, unrelated parameter name (not a nested object), so it is ignored
      // and the server clock is used. Nothing from it reaches the database.
      const { status, body } = await api.call('GET', '/dashboard/stats?now[$ne]=x');
      assert.equal(status, 200);
      assert.match(body.data.now.date, /^\d{4}-\d{2}-\d{2}$/);
    });

    test('only GET is allowed; the endpoint changes nothing', async () => {
      await seedScenario();
      const before = (await stats(api)).body.data.counts;
      assert.equal((await api.call('POST', '/dashboard/stats', {})).status, 404);
      assert.equal((await api.call('DELETE', '/dashboard/stats')).status, 404);
      assert.deepEqual((await stats(api)).body.data.counts, before);
    });
  });
});
