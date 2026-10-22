import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Assignment from '../src/models/Assignment.js';
import Subject from '../src/models/Subject.js';
import Task from '../src/models/Task.js';
import { findDanglingReferences } from '../src/utils/integrity.js';
import {
  startApiTestServer,
  cleanupRunData,
  countRunTasks,
  findOrphanedTasks,
  testName,
  testDbAvailable,
  RUN_TAG,
} from './helpers/apiTest.js';

const SKIP = testDbAvailable ? false : 'MONGODB_TEST_URI is not set in server/.env';
const MISSING_ID = '64b7f0c2a1b2c3d4e5f60718'; // valid format, but no such record
const NOW = '2026-10-21T14:30'; // a fixed "current time" (Wednesday) so results never depend on the real clock

describe('Tasks API (database: studyflow_test)', { skip: SKIP }, () => {
  let api;

  before(async () => {
    api = await startApiTestServer();
    await Subject.init();
    await Assignment.init();
    await Task.init();
  });
  after(async () => {
    await cleanupRunData();
    await api.close();
  });
  beforeEach(cleanupRunData);

  // ---- helpers ----
  const taskBody = (fields = {}) => ({ title: testName('Read'), date: '2026-10-22', ...fields });
  const create = (fields) => api.call('POST', `/tasks?now=${NOW}`, taskBody(fields));
  const list = (query = '') => api.call('GET', `/tasks?now=${NOW}${query ? `&${query}` : ''}`);
  const titlesOf = (response) => response.body.data.map((t) => t.title);
  const labels = (response) => titlesOf(response).map((title) => title.replace(`${RUN_TAG}_`, ''));
  const makeSubject = async (label = 'Maths') => (await api.call('POST', '/subjects', { name: testName(label) })).body.data;
  const makeAssignment = async (label = 'Essay', fields = {}) =>
    (await api.call('POST', '/assignments', { title: testName(label), dueDate: '2026-11-01', ...fields })).body.data;
  const storedTask = (id) => mongoose.connection.collection('tasks').findOne({ _id: new mongoose.Types.ObjectId(id) });
  const assertConsistent = async () => {
    assert.deepEqual(await findOrphanedTasks(), [], 'no task may point at a missing subject or assignment');
  };

  describe('create', () => {
    test('creates a task with every field, a populated subject and a timing', async () => {
      const subject = await makeSubject();
      const { status, body } = await create({
        title: `  ${testName('Revise')}  `, description: 'Chapters 1-3', date: '2026-10-21', time: '18:00',
        priority: 'High', completed: false, subject: subject.id,
      });
      assert.equal(status, 201);
      const t = body.data;
      assert.equal(t.title, testName('Revise'));
      assert.equal(t.description, 'Chapters 1-3');
      assert.equal(t.date, '2026-10-21');
      assert.equal(t.time, '18:00');
      assert.equal(t.priority, 'High');
      assert.equal(t.completed, false);
      assert.equal(t.subject.id, subject.id);
      assert.equal(t.subject.name, subject.name);
      assert.equal(t.assignment, null);
      assert.equal(t.timing, 'today');
      assert.ok(t.id && t.createdAt && t.updatedAt);
      assert.equal(t._id, undefined);
      assert.equal(t.__v, undefined);
      assert.equal(t.priorityRank, undefined);
      assert.equal(t.timeSort, undefined);
    });

    test('a task linked to an assignment shows that assignment and its subject (read from the assignment, not copied)', async () => {
      const subject = await makeSubject();
      const assignment = await makeAssignment('Essay', { subject: subject.id });
      const { status, body } = await create({ assignment: assignment.id });
      assert.equal(status, 201);
      assert.equal(body.data.subject, null, 'the task itself stores no subject');
      assert.equal(body.data.assignment.id, assignment.id);
      assert.equal(body.data.assignment.title, assignment.title);
      assert.equal(body.data.assignment.subject.id, subject.id, 'the subject is derived through the assignment');
      assert.equal((await storedTask(body.data.id)).subject, null);
    });

    test('a minimal task (title + date) gets sensible defaults', async () => {
      const { status, body } = await create();
      assert.equal(status, 201);
      assert.equal(body.data.time, '');
      assert.equal(body.data.description, '');
      assert.equal(body.data.priority, 'Medium');
      assert.equal(body.data.completed, false);
      assert.equal(body.data.subject, null);
      assert.equal(body.data.assignment, null);
      assert.equal(body.data.timing, 'upcoming');
    });

    test('persists what was sent (re-read straight from the database)', async () => {
      const { body } = await create({ priority: 'Low', time: '07:05', date: '2031-03-09' });
      const stored = await storedTask(body.data.id);
      assert.equal(stored.date, '2031-03-09', 'plain text date, never shifted by a time zone');
      assert.equal(stored.time, '07:05');
      assert.equal(stored.priority, 'Low');
      assert.equal(stored.priorityRank, 1);
      assert.equal(stored.timeSort, '07:05');
      assert.equal((await storedTask((await create()).body.data.id)).timeSort, '99:99', 'no time sorts last');
    });

    test('rejects missing, blank, non-text and too-long titles', async () => {
      assert.equal((await api.call('POST', '/tasks', { date: '2026-10-22' })).status, 400);
      for (const title of ['', '   ', 5, { $ne: null }, ['a'], true, 'x'.repeat(151)]) {
        const { status, body } = await create({ title });
        assert.equal(status, 400, `title ${JSON.stringify(title)}`);
        assert.equal(body.error.details[0].field, 'title');
      }
    });

    test('rejects missing and impossible dates', async () => {
      const missing = await api.call('POST', '/tasks', { title: testName('x') });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error.details[0].field, 'date');
      for (const date of ['', '2026-02-30', '2025-02-29', '2026-13-01', '26-10-25', '2026/10/25', 20261025, {}, '1999-12-31', '2101-01-01']) {
        const { status, body } = await create({ date });
        assert.equal(status, 400, `date ${JSON.stringify(date)}`);
        assert.equal(body.error.details[0].field, 'date');
      }
      assert.equal((await create({ date: '2028-02-29' })).status, 201, 'a real leap day is fine');
    });

    test('rejects invalid times, priorities, completed flags and descriptions', async () => {
      const cases = [
        ['time', '24:00'], ['time', '9:30'], ['time', '12:60'], ['time', 1230],
        ['priority', 'Urgent'], ['priority', 'high'], ['priority', 3], ['priority', { $ne: 'x' }],
        ['completed', 'true'], ['completed', 1], ['completed', {}], ['completed', ['x']],
        ['description', 'x'.repeat(1001)], ['description', 5],
      ];
      for (const [field, value] of cases) {
        const { status, body } = await create({ [field]: value });
        assert.equal(status, 400, `${field} = ${JSON.stringify(value)}`);
        assert.equal(body.error.details[0].field, field);
      }
    });

    test('reports every problem at once', async () => {
      const { status, body } = await api.call('POST', '/tasks', { title: '', date: 'nope', priority: 'Urgent' });
      assert.equal(status, 400);
      assert.deepEqual(body.error.details.map((d) => d.field).sort(), ['date', 'priority', 'title']);
    });

    test('links are validated on the server: bad ids, wrong types, nonexistent targets, and both at once', async () => {
      const subject = await makeSubject();
      const assignment = await makeAssignment();
      for (const field of ['subject', 'assignment']) {
        for (const value of ['abc', '123', MISSING_ID.slice(1), 123, { $ne: null }, [MISSING_ID]]) {
          const { status, body } = await create({ [field]: value });
          assert.equal(status, 400, `${field} ${JSON.stringify(value)}`);
          assert.equal(body.error.details[0].field, field);
        }
      }
      const noSubject = await create({ subject: MISSING_ID });
      assert.equal(noSubject.status, 400);
      assert.match(noSubject.body.error.message, /selected subject does not exist/);
      const noAssignment = await create({ assignment: MISSING_ID });
      assert.equal(noAssignment.status, 400);
      assert.match(noAssignment.body.error.message, /selected assignment does not exist/);
      assert.equal(noAssignment.body.error.details[0].field, 'assignment');

      const both = await create({ subject: subject.id, assignment: assignment.id });
      assert.equal(both.status, 400);
      assert.match(both.body.error.details[0].message, /subject or an assignment, not both/);
      assert.equal(await countRunTasks(), 0, 'nothing was created');
    });

    test('empty links (null, "" or missing) mean "not linked"', async () => {
      for (const value of [null, '', undefined]) {
        const { status, body } = await create({ subject: value, assignment: value });
        assert.equal(status, 201);
        assert.equal(body.data.subject, null);
        assert.equal(body.data.assignment, null);
      }
    });

    test('invalid requests never create records', async () => {
      for (const payload of [{}, { title: 'x' }, { date: '2026-10-25' }, { title: '', date: '2026-10-25' }, { title: 'x', date: '2026-02-30' }]) {
        assert.equal((await api.call('POST', '/tasks', { ...payload })).status, 400);
      }
      assert.equal(await mongoose.connection.collection('tasks').countDocuments({}), 0);
    });

    test('ignores fields users must not set (mass assignment)', async () => {
      const { status, body } = await create({
        _id: MISSING_ID, createdAt: '2000-01-01T00:00:00.000Z', priorityRank: 99, timeSort: '00:00', $set: { title: 'hacked' }, isAdmin: true,
      });
      assert.equal(status, 201);
      assert.notEqual(body.data.id, MISSING_ID);
      assert.notEqual(body.data.createdAt, '2000-01-01T00:00:00.000Z');
      assert.equal(body.data.isAdmin, undefined);
      const stored = await storedTask(body.data.id);
      assert.equal(stored.priorityRank, 2, 'rank follows the priority name');
      assert.equal(stored.timeSort, '99:99', 'sort helper follows the time');
    });

    test('there is no login in this app (authorization: not applicable)', async () => {
      assert.equal((await api.call('GET', '/tasks')).status, 200);
    });
  });

  describe('read: get one, list, filter, search, sort, page', () => {
    test('gets one task by id; bad ids give 400; unknown ids give 404', async () => {
      const created = (await create()).body.data;
      const { status, body } = await api.call('GET', `/tasks/${created.id}?now=${NOW}`);
      assert.equal(status, 200);
      assert.equal(body.data.title, testName('Read'));
      assert.equal((await api.call('GET', '/tasks/not-an-id')).status, 400);
      const missing = await api.call('GET', `/tasks/${MISSING_ID}`);
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.message, 'Task not found.');
    });

    test('lists nothing sensibly when there are no tasks', async () => {
      const { status, body } = await list();
      assert.equal(status, 200);
      assert.deepEqual(body.data, []);
      assert.deepEqual(body.meta, { total: 0, page: 1, limit: 100 });
    });

    test("today's tasks: filtering by one exact day returns that day's tasks, done and not done", async () => {
      await create({ title: testName('today-open'), date: '2026-10-21' });
      await create({ title: testName('today-done'), date: '2026-10-21', completed: true });
      await create({ title: testName('tomorrow'), date: '2026-10-22' });
      await create({ title: testName('yesterday'), date: '2026-10-20' });
      assert.deepEqual(labels(await list('date=2026-10-21')).sort(), ['today-done', 'today-open']);
      assert.deepEqual(labels(await list('date=2026-10-21&completed=false')), ['today-open']);
      assert.deepEqual(labels(await list('date=2026-10-21&completed=true')), ['today-done']);
      assert.deepEqual(labels(await list('date=2027-01-01')), []);
    });

    describe('timing (overdue / today / upcoming / completed) with now = Wed 2026-10-21 14:30', () => {
      beforeEach(async () => {
        const add = (label, fields) => create({ title: testName(label), ...fields });
        await add('done', { completed: true, date: '2026-10-01' });
        await add('doneToday', { completed: true, date: '2026-10-21', time: '08:00' });
        await add('late', { date: '2026-10-20' });
        await add('todayEarlier', { date: '2026-10-21', time: '09:00' });
        await add('todayLater', { date: '2026-10-21', time: '18:00' });
        await add('todayNoTime', { date: '2026-10-21' });
        await add('future', { date: '2026-10-22' });
      });
      const expected = {
        overdue: ['late', 'todayEarlier'],
        today: ['todayLater', 'todayNoTime'],
        upcoming: ['future'],
        completed: ['done', 'doneToday'],
      };

      test('each task is labelled with the right timing', async () => {
        const byTitle = Object.fromEntries((await list()).body.data.map((t) => [t.title.replace(`${RUN_TAG}_`, ''), t.timing]));
        for (const [timing, keys] of Object.entries(expected)) for (const key of keys) assert.equal(byTitle[key], timing, key);
      });

      test('filtering by timing returns exactly that group; the four groups cover everything once', async () => {
        let total = 0;
        for (const [timing, keys] of Object.entries(expected)) {
          const response = await list(`timing=${timing}`);
          assert.deepEqual(labels(response).sort(), [...keys].sort(), timing);
          total += response.body.meta.total;
        }
        assert.equal(total, 7);
      });

      test('completing an overdue task moves it out of overdue; reopening moves it back', async () => {
        const late = (await list('timing=overdue')).body.data.find((t) => t.title === testName('late'));
        const done = await api.call('PATCH', `/tasks/${late.id}/completed?now=${NOW}`, { completed: true });
        assert.equal(done.body.data.timing, 'completed');
        assert.ok(!labels(await list('timing=overdue')).includes('late'));
        assert.equal((await api.call('PATCH', `/tasks/${late.id}/completed?now=${NOW}`, { completed: false })).body.data.timing, 'overdue');
      });

      test('the same data is classified differently at a different "now"', async () => {
        const later = await api.call('GET', '/tasks?now=2026-10-23T08:00&timing=overdue&limit=200');
        assert.deepEqual(labels(later).sort(), ['future', 'late', 'todayEarlier', 'todayLater', 'todayNoTime']);
      });
    });

    describe('filters', () => {
      let maths;
      let assignment;
      beforeEach(async () => {
        maths = await makeSubject('Maths');
        assignment = await makeAssignment('Essay');
        await create({ title: testName('M-high'), subject: maths.id, priority: 'High', date: '2026-10-21', completed: false });
        await create({ title: testName('A-low'), assignment: assignment.id, priority: 'Low', date: '2026-10-22', completed: true });
        await create({ title: testName('Loose-med'), priority: 'Medium', date: '2026-10-25' });
      });
      const names = (response) => labels(response).sort();

      test('by subject, by assignment, and by "none"', async () => {
        assert.deepEqual(names(await list(`subject=${maths.id}`)), ['M-high']);
        assert.deepEqual(names(await list('subject=none')), ['A-low', 'Loose-med']);
        assert.deepEqual(names(await list(`assignment=${assignment.id}`)), ['A-low']);
        assert.deepEqual(names(await list('assignment=none')), ['Loose-med', 'M-high']);
      });

      test('by priority, completion and date range (inclusive)', async () => {
        assert.deepEqual(names(await list('priority=High')), ['M-high']);
        assert.deepEqual(names(await list('priority=Low')), ['A-low']);
        assert.deepEqual(names(await list('completed=true')), ['A-low']);
        assert.deepEqual(names(await list('dateFrom=2026-10-22&dateTo=2026-10-25')), ['A-low', 'Loose-med']);
        assert.deepEqual(names(await list('dateFrom=2026-10-23')), ['Loose-med']);
        assert.deepEqual(names(await list('dateTo=2026-10-21')), ['M-high']);
      });

      test('filters combine (AND)', async () => {
        assert.deepEqual(names(await list(`subject=${maths.id}&priority=High&completed=false`)), ['M-high']);
        assert.deepEqual(names(await list(`subject=${maths.id}&completed=true`)), []);
      });

      test('search by title is case-insensitive and treats special characters literally', async () => {
        assert.deepEqual(names(await list('q=LOOSE')), ['Loose-med']);
        await create({ title: testName('a.b notes') });
        await create({ title: testName('axb notes') });
        assert.deepEqual(names(await list(`q=${encodeURIComponent('a.b')}`)), ['a.b notes'], '"." is not a wildcard');
        assert.deepEqual(names(await list(`q=${encodeURIComponent('(')}`)), [], 'a lone "(" does not crash the search');
        assert.deepEqual(names(await list(`q=${encodeURIComponent('.*')}`)), []);
      });

      test('invalid filter values are rejected with 400', async () => {
        for (const query of [
          'completed=yes', 'priority=Urgent', 'timing=late', 'sort=title', 'order=sideways', 'date=2026-02-30', 'dateFrom=tomorrow',
          'dateFrom=2026-12-01&dateTo=2026-01-01', 'subject=abc', 'assignment=abc', 'now=today', `q=${'x'.repeat(101)}`, 'completed=true&completed=false',
        ]) {
          const { status, body } = await api.call('GET', `/tasks?${query}`);
          assert.equal(status, 400, query);
          assert.equal(body.success, false);
        }
      });

      test('database operators in the query string are never applied', async () => {
        const withOperator = await list('priority[$ne]=High');
        assert.equal(withOperator.status, 200);
        assert.deepEqual(names(withOperator), names(await list('')));
        assert.ok(labels(withOperator).includes('M-high'), 'the High task is still returned');
      });
    });

    describe('sorting and paging', () => {
      beforeEach(async () => {
        await create({ title: testName('A'), date: '2026-10-22', time: '15:00', priority: 'High' });
        await create({ title: testName('B'), date: '2026-10-22', time: '09:00', priority: 'Low' });
        await create({ title: testName('C'), date: '2026-10-22', priority: 'High' });
        await create({ title: testName('D'), date: '2026-10-22', priority: 'Low' });
        await create({ title: testName('E'), date: '2026-10-21', priority: 'Medium' });
      });
      const order = async (query) => (await list(query)).body.data.map((t) => t.title.slice(-1)).join('');

      test('by schedule (default): earliest day first, timed tasks in time order, untimed last, then High priority first', async () => {
        assert.equal(await order(''), 'EBACD');
        assert.equal(await order('sort=schedule'), 'EBACD');
        assert.equal(await order('sort=schedule&order=desc'), 'CDABE');
      });

      test('by priority: High first by default; ties by day then time; reversible', async () => {
        assert.equal(await order('sort=priority'), 'ACEBD');
        assert.equal(await order('sort=priority&order=asc'), 'BDEAC');
      });

      test('by creation: newest first by default; reversible', async () => {
        assert.equal(await order('sort=createdAt'), 'EDCBA');
        assert.equal(await order('sort=createdAt&order=asc'), 'ABCDE');
      });

      test('paging returns the right slice and total; limits are capped; nonsense falls back', async () => {
        const page2 = await list('limit=3&page=2');
        assert.equal(page2.body.data.length, 2);
        assert.deepEqual(page2.body.meta, { total: 5, page: 2, limit: 3 });
        assert.equal((await list('limit=999999')).body.meta.limit, 200);
        assert.deepEqual((await list('limit=-1&page=abc')).body.meta, { total: 5, page: 1, limit: 100 });
      });
    });
  });

  describe('update and complete', () => {
    test('replaces the fields, keeps createdAt, moves updatedAt, and the change persists', async () => {
      const created = (await create({ description: 'old', priority: 'Low', time: '10:00' })).body.data;
      await new Promise((resolve) => setTimeout(resolve, 20));

      const { status, body } = await api.call('PUT', `/tasks/${created.id}?now=${NOW}`, taskBody({ title: testName('Renamed'), date: '2026-10-21', time: '12:00', priority: 'High' }));
      assert.equal(status, 200);
      assert.equal(body.data.title, testName('Renamed'));
      assert.equal(body.data.description, '', 'PUT replaces: omitted optional fields are cleared');
      assert.equal(body.data.timing, 'overdue', 'timing is recomputed for the new time');
      assert.equal(body.data.createdAt, created.createdAt);
      assert.ok(new Date(body.data.updatedAt) > new Date(created.updatedAt));
      const stored = await storedTask(created.id);
      assert.equal(stored.priorityRank, 3);
      assert.equal(stored.timeSort, '12:00');
    });

    test('can switch the link between a subject and an assignment, and clear it', async () => {
      const subject = await makeSubject();
      const assignment = await makeAssignment();
      const created = (await create({ subject: subject.id })).body.data;
      const put = (fields) => api.call('PUT', `/tasks/${created.id}`, taskBody(fields));

      const toAssignment = (await put({ assignment: assignment.id })).body.data;
      assert.equal(toAssignment.assignment.id, assignment.id);
      assert.equal(toAssignment.subject, null, 'the old subject link is gone');
      const toSubject = (await put({ subject: subject.id })).body.data;
      assert.equal(toSubject.subject.id, subject.id);
      assert.equal(toSubject.assignment, null);
      const cleared = (await put({})).body.data;
      assert.equal(cleared.subject, null);
      assert.equal(cleared.assignment, null);
    });

    test('invalid updates are rejected and leave the stored task unchanged', async () => {
      const subject = await makeSubject();
      const created = (await create({ subject: subject.id, description: 'keep me' })).body.data;
      const before = await storedTask(created.id);
      const assignment = await makeAssignment();
      const badPayloads = [
        {}, { title: '   ' }, taskBody({ date: '2026-02-30' }), taskBody({ priority: 'Urgent' }), taskBody({ completed: 'yes' }),
        taskBody({ subject: 'abc' }), taskBody({ subject: MISSING_ID }), taskBody({ assignment: MISSING_ID }),
        taskBody({ subject: subject.id, assignment: assignment.id }), taskBody({ title: 5 }),
      ];
      for (const payload of badPayloads) {
        assert.equal((await api.call('PUT', `/tasks/${created.id}`, payload)).status, 400, JSON.stringify(payload));
      }
      assert.deepEqual(await storedTask(created.id), before);
    });

    test('bad ids give 400; unknown ids give 404', async () => {
      assert.equal((await api.call('PUT', '/tasks/not-an-id', taskBody())).status, 400);
      const missing = await api.call('PUT', `/tasks/${MISSING_ID}`, taskBody());
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.message, 'Task not found.');
    });

    test('ticking a task off and on works, validates, and 404s for unknown ids', async () => {
      const created = (await create()).body.data;
      const patch = (id, body) => api.call('PATCH', `/tasks/${id}/completed?now=${NOW}`, body);

      const done = await patch(created.id, { completed: true });
      assert.equal(done.status, 200);
      assert.equal(done.body.data.completed, true);
      assert.equal((await storedTask(created.id)).completed, true);
      assert.equal((await storedTask(created.id)).title, testName('Read'), 'nothing else changed');
      assert.equal((await patch(created.id, { completed: false })).body.data.completed, false);

      for (const bad of [{}, { completed: 'true' }, { completed: 1 }, { completed: [true] }, { title: 'x' }]) {
        assert.equal((await patch(created.id, bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await patch(MISSING_ID, { completed: true })).status, 404);
      assert.equal((await patch('nope', { completed: true })).status, 400);
    });

    test('updating while another request deletes the task gives 200 or 404, never a 500', async () => {
      for (let round = 0; round < 5; round += 1) {
        const created = (await create({ title: testName(`Race${round}`) })).body.data;
        const [update, remove] = await Promise.all([
          api.call('PUT', `/tasks/${created.id}`, taskBody({ title: testName(`Race${round}b`) })),
          api.call('DELETE', `/tasks/${created.id}`),
        ]);
        assert.ok([200, 404].includes(update.status), `update gave ${update.status}`);
        assert.equal(remove.status, 200);
        assert.equal(await Task.countDocuments({ _id: created.id }), 0);
      }
    });
  });

  describe('delete', () => {
    test('deletes a task; deleting again gives 404; bad ids give 400; its subject and assignment are untouched', async () => {
      const subject = await makeSubject();
      const assignment = await makeAssignment();
      const [one, two] = [(await create({ subject: subject.id })).body.data, (await create({ assignment: assignment.id })).body.data];
      assert.equal((await api.call('DELETE', `/tasks/${one.id}`)).status, 200);
      assert.equal((await api.call('DELETE', `/tasks/${two.id}`)).status, 200);
      assert.equal(await countRunTasks(), 0);
      assert.equal((await api.call('GET', `/tasks/${one.id}`)).status, 404);
      assert.equal((await api.call('DELETE', `/tasks/${one.id}`)).status, 404);
      assert.equal((await api.call('DELETE', '/tasks/not-an-id')).status, 400);
      assert.equal((await api.call('GET', `/subjects/${subject.id}`)).status, 200);
      assert.equal((await api.call('GET', `/assignments/${assignment.id}`)).status, 200);
    });

    test('parallel deletes of one task give one 200 and the rest 404', async () => {
      const created = (await create()).body.data;
      const results = await Promise.all(Array.from({ length: 5 }, () => api.call('DELETE', `/tasks/${created.id}`)));
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 404, 404, 404, 404]);
    });
  });

  describe('integration with subjects and assignments (Phase 3 and 4 behaviour must still hold)', () => {
    test('a subject with tasks cannot be deleted, and nothing changes; it can once the tasks are gone or moved', async () => {
      const [first, second] = [await makeSubject('First'), await makeSubject('Second')];
      const a = (await create({ subject: first.id })).body.data;
      const b = (await create({ subject: first.id })).body.data;
      const blocked = await api.call('DELETE', `/subjects/${first.id}`);
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error.message, /still used by 2 tasks/);
      assert.equal((await api.call('GET', `/subjects/${first.id}`)).status, 200);

      await api.call('DELETE', `/tasks/${a.id}`);
      assert.equal((await api.call('DELETE', `/subjects/${first.id}`)).status, 409, 'one task is left');
      await api.call('PUT', `/tasks/${b.id}`, taskBody({ subject: second.id }));
      assert.equal((await api.call('DELETE', `/subjects/${first.id}`)).status, 200);
      await assertConsistent();
    });

    test('the delete message counts assignments and tasks together', async () => {
      const subject = await makeSubject();
      await makeAssignment('Essay', { subject: subject.id });
      await create({ subject: subject.id });
      const { status, body } = await api.call('DELETE', `/subjects/${subject.id}`);
      assert.equal(status, 409);
      assert.match(body.error.message, /1 assignment and 1 task/);
    });

    test('deleting an assignment keeps its tasks and clears their link (other tasks are untouched)', async () => {
      const assignment = await makeAssignment();
      const other = await makeAssignment('Other');
      const subject = await makeSubject();
      const linked = (await create({ title: testName('Linked'), assignment: assignment.id })).body.data;
      const untouchedA = (await create({ title: testName('Other link'), assignment: other.id })).body.data;
      const untouchedB = (await create({ title: testName('Subject link'), subject: subject.id })).body.data;
      const storedBefore = await Promise.all([untouchedA, untouchedB].map((t) => storedTask(t.id)));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const deleted = await api.call('DELETE', `/assignments/${assignment.id}`);
      assert.equal(deleted.status, 200);
      assert.equal((await api.call('GET', `/assignments/${assignment.id}`)).status, 404);

      const after = (await api.call('GET', `/tasks/${linked.id}`)).body.data;
      assert.equal(after.assignment, null, 'the link was cleared');
      assert.equal(after.title, testName('Linked'), 'the task itself still exists');
      assert.ok(new Date(after.updatedAt) > new Date(linked.updatedAt), 'its updatedAt reflects the change');
      assert.deepEqual(await Promise.all([untouchedA, untouchedB].map((t) => storedTask(t.id))), storedBefore, 'other tasks are unchanged');
      await assertConsistent();
    });

    test('deleting an assignment that no task uses works as before', async () => {
      const assignment = await makeAssignment();
      assert.equal((await api.call('DELETE', `/assignments/${assignment.id}`)).status, 200);
      assert.equal((await api.call('DELETE', `/assignments/${assignment.id}`)).status, 404);
      assert.equal((await api.call('DELETE', '/assignments/not-an-id')).status, 400);
    });

    test('renaming a subject or moving an assignment to another subject shows up on linked tasks', async () => {
      const [maths, physics] = [await makeSubject('Maths'), await makeSubject('Physics')];
      const assignment = await makeAssignment('Essay', { subject: maths.id });
      const task = (await create({ assignment: assignment.id })).body.data;
      const subjectOf = async () => (await api.call('GET', `/tasks/${task.id}`)).body.data.assignment.subject;

      assert.equal((await subjectOf()).name, maths.name);
      await api.call('PUT', `/subjects/${maths.id}`, { name: testName('Mathematics') });
      assert.equal((await subjectOf()).name, testName('Mathematics'));
      await api.call('PUT', `/assignments/${assignment.id}`, { title: assignment.title, dueDate: assignment.dueDate, subject: physics.id });
      assert.equal((await subjectOf()).id, physics.id);
    });

    test('editing an assignment does not disturb the tasks linked to it', async () => {
      const assignment = await makeAssignment();
      const task = (await create({ assignment: assignment.id })).body.data;
      await api.call('PUT', `/assignments/${assignment.id}`, { title: testName('Renamed essay'), dueDate: '2026-12-01' });
      await api.call('PATCH', `/assignments/${assignment.id}/status`, { status: 'Completed' });
      const after = (await api.call('GET', `/tasks/${task.id}`)).body.data;
      assert.equal(after.assignment.id, assignment.id);
      assert.equal(after.assignment.title, testName('Renamed essay'));
    });

    test('the integrity checker also covers task links', async () => {
      const assignment = await makeAssignment();
      await create({ assignment: assignment.id });
      assert.deepEqual(await findDanglingReferences(), []);

      const missing = new mongoose.Types.ObjectId();
      const { insertedId } = await mongoose.connection.collection('tasks').insertOne({ title: testName('Damaged'), assignment: missing, testRun: RUN_TAG });
      assert.deepEqual(await findDanglingReferences(), [{ collection: 'tasks', id: insertedId.toString(), field: 'assignment', missing: missing.toString() }]);
    });

    test('hidden lock counters are never exposed on assignments or tasks', async () => {
      const assignment = await makeAssignment();
      const task = (await create({ assignment: assignment.id })).body.data;
      assert.equal(task.assignment.referenceVersion, undefined);
      assert.equal((await api.call('GET', `/assignments/${assignment.id}`)).body.data.referenceVersion, undefined);
      assert.equal((await api.call('GET', '/assignments')).body.data.some((a) => 'referenceVersion' in a), false);
    });
  });
});
