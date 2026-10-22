import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Assignment from '../src/models/Assignment.js';
import StudySession from '../src/models/StudySession.js';
import Subject from '../src/models/Subject.js';
import Task from '../src/models/Task.js';
import { startApiTestServer, cleanupRunData, testName, testDbAvailable, RUN_TAG } from './helpers/apiTest.js';

const SKIP = testDbAvailable ? false : 'MONGODB_TEST_URI is not set in server/.env';
const NOW = '2026-10-21T14:30'; // Wednesday, 14:30

describe('Calendar API (database: studyflow_test)', { skip: SKIP }, () => {
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

  const calendar = (query) => api.call('GET', `/calendar?${query}`);
  const month = (extra = '') => calendar(`from=2026-10-01&to=2026-10-31&now=${NOW}${extra}`);
  const assignment = async (label, dueDate, fields = {}) =>
    (await api.call('POST', '/assignments', { title: testName(label), dueDate, subject: maths.id, ...fields })).body.data;
  const task = async (label, date, fields = {}) => (await api.call('POST', '/tasks', { title: testName(label), date, ...fields })).body.data;
  const session = async (label, date, fields = {}) =>
    (await api.call('POST', '/study-sessions', { subject: maths.id, date, durationMinutes: 30, notes: testName(label), ...fields })).body.data;
  const ids = (response) => response.body.data.events.map((event) => event.id);

  describe('events', () => {
    test('an empty range returns an empty list (not an error)', async () => {
      const { status, body } = await month();
      assert.equal(status, 200);
      assert.deepEqual(body.data.events, []);
      assert.deepEqual(body.data.truncated, []);
      assert.deepEqual([body.data.from, body.data.to], ['2026-10-01', '2026-10-31']);
    });

    test('assignments appear on their due date with status, priority, timing and subject', async () => {
      const a = await assignment('Essay', '2026-10-23', { dueTime: '09:00', priority: 'High', status: 'In Progress' });
      const [event] = (await month()).body.data.events;
      assert.deepEqual(event, {
        id: a.id, type: 'assignment', date: '2026-10-23', time: '09:00', title: a.title,
        subject: { id: maths.id, name: maths.name, color: '#2563eb' }, status: 'In Progress', priority: 'High', timing: 'dueSoon',
      });
    });

    test('tasks appear on their date; a task linked to an assignment takes that assignment\'s subject', async () => {
      const a = await assignment('Project', '2026-10-30');
      const direct = await api.call('POST', '/tasks', { title: testName('direct'), date: '2026-10-22', subject: history.id });
      const linked = await api.call('POST', '/tasks', { title: testName('linked'), date: '2026-10-22', assignment: a.id, time: '10:00' });
      const events = (await month()).body.data.events.filter((e) => e.type === 'task');
      const byId = Object.fromEntries(events.map((e) => [e.id, e]));
      assert.equal(byId[direct.body.data.id].subject.name, history.name);
      assert.equal(byId[direct.body.data.id].assignmentTitle, null);
      assert.equal(byId[linked.body.data.id].subject.name, maths.name);
      assert.equal(byId[linked.body.data.id].assignmentTitle, a.title);
      assert.equal(byId[linked.body.data.id].time, '10:00');
      assert.equal(byId[linked.body.data.id].completed, false);
    });

    test('sessions are "planned" while still ahead of the clock and "recorded" once they have happened', async () => {
      const past = await session('past day', '2026-10-20');
      const earlierToday = await session('earlier today', '2026-10-21', { startTime: '09:00' });
      const laterToday = await session('later today', '2026-10-21', { startTime: '18:00' });
      const untimedToday = await session('untimed today', '2026-10-21');
      const future = await session('future day', '2026-10-22');
      const state = Object.fromEntries((await month()).body.data.events.map((e) => [e.id, e.state]));
      assert.equal(state[past.id], 'recorded');
      assert.equal(state[earlierToday.id], 'recorded');
      assert.equal(state[laterToday.id], 'planned');
      assert.equal(state[untimedToday.id], 'recorded');
      assert.equal(state[future.id], 'planned');
      // moving the user's clock moves the boundary
      const evening = Object.fromEntries((await calendar('from=2026-10-21&to=2026-10-21&now=2026-10-21T18:00')).body.data.events.map((e) => [e.id, e.state]));
      assert.equal(evening[laterToday.id], 'recorded', 'at exactly the start time it counts as started');
      const morning = Object.fromEntries((await calendar('from=2026-10-21&to=2026-10-21&now=2026-10-21T08:00')).body.data.events.map((e) => [e.id, e.state]));
      assert.equal(morning[earlierToday.id], 'planned');
    });

    test('session events carry duration, type, subject and assignment', async () => {
      const a = await assignment('Linked', '2026-10-30');
      const s = await session('rich', '2026-10-22', { startTime: '16:00', durationMinutes: 75, type: 'Revision', assignment: a.id });
      const event = (await month()).body.data.events.find((e) => e.id === s.id);
      assert.equal(event.durationMinutes, 75);
      assert.equal(event.sessionType, 'Revision');
      assert.equal(event.assignmentTitle, a.title);
      assert.equal(event.subject.name, maths.name);
      assert.equal(event.time, '16:00');
    });

    test('the same timing words as the pages: overdue, completed, today, upcoming', async () => {
      const overdue = await task('overdue', '2026-10-20');
      const done = await task('done', '2026-10-20', { completed: true });
      const today = await task('today', '2026-10-21');
      const upcoming = await task('upcoming', '2026-10-22');
      const timing = Object.fromEntries((await month()).body.data.events.map((e) => [e.id, e.timing]));
      assert.deepEqual([timing[overdue.id], timing[done.id], timing[today.id], timing[upcoming.id]], ['overdue', 'completed', 'today', 'upcoming']);
      const completedAssignment = await assignment('done a', '2026-10-01', { status: 'Completed' });
      const overdueAssignment = await assignment('late a', '2026-10-02');
      const events = Object.fromEntries((await month()).body.data.events.map((e) => [e.id, e.timing]));
      assert.equal(events[completedAssignment.id], 'completed');
      assert.equal(events[overdueAssignment.id], 'overdue');
    });
  });

  describe('range boundaries', () => {
    test('from and to are inclusive; the day before and the day after are excluded', async () => {
      const before = await task('before', '2026-09-30');
      const first = await task('first', '2026-10-01');
      const last = await task('last', '2026-10-31');
      const after = await task('after', '2026-11-01');
      const found = ids(await month());
      assert.deepEqual(found.sort(), [first.id, last.id].sort());
      assert.equal(found.includes(before.id) || found.includes(after.id), false);
    });

    test('a single-day range works', async () => {
      const t = await task('one day', '2026-10-21');
      await task('next day', '2026-10-22');
      assert.deepEqual(ids(await calendar(`from=2026-10-21&to=2026-10-21&now=${NOW}`)), [t.id]);
    });

    test('ranges across a month, year and leap day', async () => {
      const a = await task('new year eve', '2026-12-31');
      const b = await task('new year', '2027-01-01');
      const leap = await task('leap', '2028-02-29');
      assert.deepEqual(ids(await calendar(`from=2026-12-28&to=2027-01-03&now=${NOW}`)).sort(), [a.id, b.id].sort());
      assert.deepEqual(ids(await calendar(`from=2028-02-27&to=2028-03-01&now=${NOW}`)), [leap.id]);
    });

    test('a range of exactly 62 days is allowed; 63 is rejected', async () => {
      assert.equal((await calendar(`from=2026-09-01&to=2026-11-01&now=${NOW}`)).status, 200); // 30 + 31 + 1 = 62 days
      const tooLong = await calendar(`from=2026-09-01&to=2026-11-02&now=${NOW}`);
      assert.equal(tooLong.status, 400);
      assert.match(tooLong.body.error.message, /62 days/);
    });
  });

  describe('sorting', () => {
    test('by date, then time (untimed last), then kind (assignment, task, session)', async () => {
      const session1 = await session('s untimed', '2026-10-22');
      const task1 = await task('t untimed', '2026-10-22');
      const assignment1 = await assignment('a untimed', '2026-10-22');
      const task2 = await task('t timed late', '2026-10-22', { time: '18:00' });
      const task3 = await task('t timed early', '2026-10-22', { time: '08:00' });
      const earlier = await task('earlier day', '2026-10-20');
      const later = await task('later day', '2026-10-23');
      assert.deepEqual(ids(await month()), [earlier.id, task3.id, task2.id, assignment1.id, task1.id, session1.id, later.id]);
    });
  });

  describe('filters', () => {
    test('types: only the requested kinds are returned', async () => {
      const a = await assignment('a', '2026-10-22');
      const t = await task('t', '2026-10-22');
      const s = await session('s', '2026-10-22');
      assert.deepEqual(ids(await month('&types=assignment')), [a.id]);
      assert.deepEqual(ids(await month('&types=task')), [t.id]);
      assert.deepEqual(ids(await month('&types=session')), [s.id]);
      assert.deepEqual(ids(await month('&types=task,session')), [t.id, s.id]);
      assert.deepEqual(ids(await month('&types=session,assignment,task')).sort(), [a.id, t.id, s.id].sort());
      assert.deepEqual((await month('&types=task')).body.data.types, ['task']);
    });

    test('subject: assignments, sessions, and tasks (directly or through their assignment) of that subject only', async () => {
      const mathsAssignment = await assignment('maths a', '2026-10-22');
      const historyAssignment = await assignment('history a', '2026-10-22', { subject: history.id });
      const mathsDirectTask = await api.call('POST', '/tasks', { title: testName('maths direct'), date: '2026-10-22', subject: maths.id });
      const mathsViaAssignment = await api.call('POST', '/tasks', { title: testName('maths via a'), date: '2026-10-22', assignment: mathsAssignment.id });
      const historyTask = await api.call('POST', '/tasks', { title: testName('history task'), date: '2026-10-22', subject: history.id });
      const noSubjectTask = await task('no subject', '2026-10-22');
      const mathsSession = await session('maths s', '2026-10-22');
      const historySession = await session('history s', '2026-10-22', { subject: history.id });
      const found = ids(await month(`&subject=${maths.id}`)).sort();
      assert.deepEqual(found, [mathsAssignment.id, mathsDirectTask.body.data.id, mathsViaAssignment.body.data.id, mathsSession.id].sort());
      const other = ids(await month(`&subject=${history.id}`)).sort();
      assert.deepEqual(other, [historyAssignment.id, historyTask.body.data.id, historySession.id].sort());
      assert.equal(ids(await month()).includes(noSubjectTask.id), true);
    });

    test('a subject with nothing in the range returns an empty list', async () => {
      await assignment('maths only', '2026-10-22');
      assert.deepEqual((await month(`&subject=${history.id}`)).body.data.events, []);
    });

    test('a well-formed subject id that does not exist returns an empty list, not an error', async () => {
      await assignment('x', '2026-10-22');
      const { status, body } = await month('&subject=64b7f0c2a1b2c3d4e5f60718');
      assert.equal(status, 200);
      assert.deepEqual(body.data.events, []);
    });
  });

  describe('invalid input', () => {
    const bad = async (query, field) => {
      const { status, body } = await calendar(query);
      assert.equal(status, 400, query);
      assert.equal(body.success, false);
      if (field) assert.ok(body.error.details?.some((d) => d.field === field), `${query} -> ${JSON.stringify(body.error)}`);
    };

    test('from and to are required and must be real dates', async () => {
      await bad('to=2026-10-31', 'from');
      await bad('from=2026-10-01', 'to');
      await bad('', 'from');
      for (const value of ['abc', '2026-13-01', '2026-02-30', '2026-10-1', '20261001', '2026-10-01T10:00', '1', '--']) {
        await bad(`from=${encodeURIComponent(value)}&to=2026-10-31`, 'from');
        await bad(`from=2026-10-01&to=${encodeURIComponent(value)}`, 'to');
      }
    });

    test('from after to is rejected', async () => {
      const { status, body } = await calendar('from=2026-10-31&to=2026-10-01');
      assert.equal(status, 400);
      assert.match(body.error.message, /must not be after/);
    });

    test('unknown or malformed types, subject and now are rejected', async () => {
      await bad('from=2026-10-01&to=2026-10-31&types=holiday', 'types');
      await bad('from=2026-10-01&to=2026-10-31&types=task,,session', 'types');
      await bad('from=2026-10-01&to=2026-10-31&types=Task', 'types');
      await bad('from=2026-10-01&to=2026-10-31&subject=abc', 'subject');
      await bad('from=2026-10-01&to=2026-10-31&subject=none', 'subject');
      await bad('from=2026-10-01&to=2026-10-31&now=tomorrow', 'now');
    });

    test('operator injection never reaches the database; repeated parameters are rejected', async () => {
      // "from[$gte]" is read as an unknown parameter name, so "from" is simply missing -> 400
      await bad('from[$gte]=2000-01-01&to=2026-10-31', 'from');
      await bad('from=2026-10-01&to[$lte]=2100-01-01', 'to');
      // An unknown "subject[$ne]" parameter is ignored: the result is the same as with no subject filter.
      await assignment('visible', '2026-10-22');
      const ignored = await month(`&subject[$ne]=${maths.id}`);
      assert.equal(ignored.status, 200);
      assert.equal(ignored.body.data.events.length, 1);
      await bad('from=2026-10-01&from=2026-10-02&to=2026-10-31', 'from');
      await bad('from=2026-10-01&to=2026-10-31&types=task&types=session', 'types');
    });

    test('only GET exists on the calendar', async () => {
      assert.equal((await api.call('POST', '/calendar', {})).status, 404);
      assert.equal((await api.call('DELETE', '/calendar')).status, 404);
    });
  });

  describe('damaged data and limits', () => {
    test('records whose subject or assignment no longer exists still appear, without a subject', async () => {
      const db = mongoose.connection;
      const ghost = new mongoose.Types.ObjectId();
      const stamp = { createdAt: new Date(), updatedAt: new Date() };
      await db.collection('assignments').insertOne({
        title: testName('ghost a'), dueDate: '2026-10-22', dueTime: '', priority: 'Medium', priorityRank: 2, status: 'Not Started',
        estimatedMinutes: null, type: '', description: '', subject: ghost, ...stamp,
      });
      await db.collection('tasks').insertOne({
        title: testName('ghost t'), description: '', date: '2026-10-22', time: '', priority: 'Medium', priorityRank: 2, timeSort: '99:99',
        completed: false, subject: null, assignment: ghost, ...stamp,
      });
      await db.collection('studysessions').insertOne({
        subject: ghost, assignment: ghost, date: '2026-10-22', startTime: '', durationMinutes: 20, notes: testName('ghost s'), type: '', ...stamp,
      });
      const { status, body } = await month();
      assert.equal(status, 200);
      assert.equal(body.data.events.length, 3);
      assert.ok(body.data.events.every((event) => event.subject === null));
      assert.equal(body.data.events.find((e) => e.type === 'session').title, 'Study session');
    });

    test('a very busy day is capped per kind and reports it (a quick check using inserts, not 500 API calls)', async () => {
      const db = mongoose.connection;
      const stamp = { createdAt: new Date(), updatedAt: new Date() };
      const rows = Array.from({ length: 501 }, (_, i) => ({
        title: `${RUN_TAG}_bulk ${i}`, description: '', date: '2026-10-22', time: '', priority: 'Medium', priorityRank: 2, timeSort: '99:99',
        completed: false, subject: null, assignment: null, ...stamp,
      }));
      await db.collection('tasks').insertMany(rows);
      const { body } = await month();
      assert.equal(body.data.events.filter((e) => e.type === 'task').length, 500);
      assert.deepEqual(body.data.truncated, ['task']);
    });
  });

  describe('stays consistent with the pages', () => {
    test('the events of a range are exactly the records the list endpoints return for the same days', async () => {
      await assignment('a1', '2026-10-05');
      await assignment('a2', '2026-10-31');
      await assignment('a3', '2026-11-02');
      await task('t1', '2026-10-01');
      await task('t2', '2026-09-30');
      await session('s1', '2026-10-15');
      await session('s2', '2026-11-01');
      const events = (await month()).body.data.events;
      const listed = async (path, query) => (await api.call('GET', `${path}?${query}&limit=200`)).body.data.map((row) => row.id);
      const count = (type) => events.filter((e) => e.type === type).map((e) => e.id).sort();
      assert.deepEqual(count('assignment'), (await listed('/assignments', 'dueFrom=2026-10-01&dueTo=2026-10-31')).sort());
      assert.deepEqual(count('task'), (await listed('/tasks', 'dateFrom=2026-10-01&dateTo=2026-10-31')).sort());
      assert.deepEqual(count('session'), (await listed('/study-sessions', 'dateFrom=2026-10-01&dateTo=2026-10-31')).sort());
    });

    test('editing, completing and deleting records changes the calendar at once', async () => {
      const t = await task('moves', '2026-10-10');
      const a = await assignment('goes away', '2026-10-12');
      assert.deepEqual(ids(await month()).sort(), [t.id, a.id].sort());

      await api.call('PUT', `/tasks/${t.id}`, { title: t.title, date: '2026-11-15' });
      assert.deepEqual(ids(await month()), [a.id]);
      assert.deepEqual(ids(await calendar(`from=2026-11-01&to=2026-11-30&now=${NOW}`)), [t.id]);

      await api.call('PATCH', `/assignments/${a.id}/status`, { status: 'Completed' });
      assert.equal((await month()).body.data.events[0].timing, 'completed');

      await api.call('DELETE', `/assignments/${a.id}`);
      assert.deepEqual((await month()).body.data.events, []);
    });
  });
});
