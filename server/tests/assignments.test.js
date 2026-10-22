import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Assignment from '../src/models/Assignment.js';
import Subject from '../src/models/Subject.js';
import {
  startApiTestServer,
  cleanupRunData,
  countRunAssignments,
  findOrphanedAssignments,
  testName,
  testDbAvailable,
} from './helpers/apiTest.js';

const SKIP = testDbAvailable ? false : 'MONGODB_TEST_URI is not set in server/.env';
const MISSING_ID = '64b7f0c2a1b2c3d4e5f60718'; // valid format, but no such record
const NOW = '2026-10-21T14:30'; // a fixed "current time" (Wednesday) so results never depend on the real clock

describe('Assignments API (database: studyflow_test)', { skip: SKIP }, () => {
  let api;

  before(async () => {
    api = await startApiTestServer();
    await Subject.init();
    await Assignment.init();
  });
  after(async () => {
    await cleanupRunData();
    await api.close();
  });
  beforeEach(cleanupRunData);

  // ---- helpers ----
  const assignmentBody = (fields = {}) => ({ title: testName('Essay'), dueDate: '2026-10-25', ...fields });
  const create = (fields) => api.call('POST', `/assignments?now=${NOW}`, assignmentBody(fields));
  const list = (query = '') => api.call('GET', `/assignments?now=${NOW}${query ? `&${query}` : ''}`);
  const titlesOf = (response) => response.body.data.map((a) => a.title);
  const makeSubject = async (label = 'Maths') => (await api.call('POST', '/subjects', { name: testName(label) })).body.data;
  const storedAssignment = (id) => mongoose.connection.collection('assignments').findOne({ _id: new mongoose.Types.ObjectId(id) });

  describe('create', () => {
    test('creates an assignment with all fields, populated subject and timing', async () => {
      const subject = await makeSubject();
      const { status, body } = await create({
        title: `  ${testName('Lab report')}  `,
        description: 'Write up the pendulum experiment',
        subject: subject.id,
        dueDate: '2026-10-23',
        dueTime: '09:30',
        priority: 'High',
        status: 'In Progress',
        estimatedMinutes: 90,
        type: 'Project',
      });
      assert.equal(status, 201);
      const a = body.data;
      assert.equal(a.title, testName('Lab report'));
      assert.equal(a.description, 'Write up the pendulum experiment');
      assert.equal(a.subject.id, subject.id);
      assert.equal(a.subject.name, subject.name);
      assert.equal(a.subject.color, '#4f46e5');
      assert.equal(a.dueDate, '2026-10-23');
      assert.equal(a.dueTime, '09:30');
      assert.equal(a.priority, 'High');
      assert.equal(a.status, 'In Progress');
      assert.equal(a.estimatedMinutes, 90);
      assert.equal(a.type, 'Project');
      assert.equal(a.timing, 'dueSoon');
      assert.ok(a.id && a.createdAt && a.updatedAt);
      assert.equal(a._id, undefined);
      assert.equal(a.__v, undefined);
      assert.equal(a.priorityRank, undefined, 'internal sorting field is not exposed');
    });

    test('a minimal assignment (title + due date) gets sensible defaults', async () => {
      const { status, body } = await create();
      assert.equal(status, 201);
      assert.equal(body.data.subject, null);
      assert.equal(body.data.description, '');
      assert.equal(body.data.dueTime, '');
      assert.equal(body.data.priority, 'Medium');
      assert.equal(body.data.status, 'Not Started');
      assert.equal(body.data.estimatedMinutes, null);
      assert.equal(body.data.type, '');
      assert.equal(body.data.timing, 'upcoming');
    });

    test('persists what was sent (re-read straight from the database)', async () => {
      const { body } = await create({ priority: 'Low', dueTime: '23:59', estimatedMinutes: '45', type: 'Exam' });
      const stored = await storedAssignment(body.data.id);
      assert.equal(stored.title, testName('Essay'));
      assert.equal(stored.dueDate, '2026-10-25'); // plain text, never shifted by timezones
      assert.equal(stored.dueTime, '23:59');
      assert.equal(stored.priority, 'Low');
      assert.equal(stored.priorityRank, 1);
      assert.equal(stored.estimatedMinutes, 45);
      assert.equal(stored.type, 'Exam');
      assert.equal(stored.subject, null);
    });

    test('rejects missing, blank, non-text and too-long titles', async () => {
      assert.equal((await api.call('POST', '/assignments', { dueDate: '2026-10-25' })).status, 400);
      for (const title of ['', '   ', 5, { $ne: null }, ['a'], true, 'x'.repeat(151)]) {
        const { status, body } = await create({ title });
        assert.equal(status, 400, `title ${JSON.stringify(title)}`);
        assert.equal(body.error.details[0].field, 'title');
      }
    });

    test('rejects missing and impossible due dates', async () => {
      const missing = await api.call('POST', '/assignments', { title: testName('x') });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error.details[0].field, 'dueDate');
      for (const dueDate of ['', '2026-02-30', '2025-02-29', '2026-13-01', '2026-10-32', '26-10-25', '2026/10/25', '2026-1-1', 20261025, {}, '1999-12-31', '2101-01-01']) {
        const { status, body } = await create({ dueDate });
        assert.equal(status, 400, `dueDate ${JSON.stringify(dueDate)}`);
        assert.equal(body.error.details[0].field, 'dueDate');
      }
      assert.equal((await create({ dueDate: '2028-02-29' })).status, 201, 'a real leap day is fine');
    });

    test('rejects invalid due times, priorities, statuses, types and estimates', async () => {
      const cases = [
        ['dueTime', '24:00'], ['dueTime', '9:30'], ['dueTime', '12:60'], ['dueTime', 1230],
        ['priority', 'Urgent'], ['priority', 'high'], ['priority', 3], ['priority', { $ne: 'x' }],
        ['status', 'Done'], ['status', 'completed'], ['status', ['Completed']],
        ['type', 'Quiz'], ['type', 5],
        ['estimatedMinutes', 0], ['estimatedMinutes', -5], ['estimatedMinutes', 1.5], ['estimatedMinutes', 'abc'], ['estimatedMinutes', 10081], ['estimatedMinutes', true],
        ['description', 'x'.repeat(2001)], ['description', 5],
      ];
      for (const [field, value] of cases) {
        const { status, body } = await create({ [field]: value });
        assert.equal(status, 400, `${field} = ${JSON.stringify(value)}`);
        assert.equal(body.error.details[0].field, field);
      }
    });

    test('reports every problem at once', async () => {
      const { status, body } = await api.call('POST', '/assignments', { title: '', dueDate: 'nope', priority: 'Urgent' });
      assert.equal(status, 400);
      assert.deepEqual(body.error.details.map((d) => d.field).sort(), ['dueDate', 'priority', 'title']);
    });

    test('invalid requests never create records', async () => {
      for (const payload of [{}, { title: 'x' }, { dueDate: '2026-10-25' }, { title: '', dueDate: '2026-10-25' }, { title: 'x', dueDate: '2026-02-30' }]) {
        assert.equal((await api.call('POST', '/assignments', { ...payload })).status, 400);
      }
      assert.equal((await create({ subject: 'not-an-id' })).status, 400);
      assert.equal((await create({ subject: MISSING_ID })).status, 400);
      assert.equal(await mongoose.connection.collection('assignments').countDocuments({}), 0);
    });

    test('ignores fields users must not set (mass assignment)', async () => {
      const { status, body } = await create({
        _id: MISSING_ID,
        createdAt: '2000-01-01T00:00:00.000Z',
        priorityRank: 99,
        $set: { title: 'hacked' },
        isAdmin: true,
      });
      assert.equal(status, 201);
      assert.notEqual(body.data.id, MISSING_ID);
      assert.notEqual(body.data.createdAt, '2000-01-01T00:00:00.000Z');
      assert.equal(body.data.isAdmin, undefined);
      assert.equal((await storedAssignment(body.data.id)).priorityRank, 2, 'rank always follows the priority name');
    });

    test('there is no login in this app, so no endpoint refuses by user (authorization: not applicable)', async () => {
      const { status } = await api.call('GET', '/assignments');
      assert.equal(status, 200);
    });
  });

  describe('subject references (validated on the server)', () => {
    test('accepts an existing subject and no subject (null, "" or missing)', async () => {
      const subject = await makeSubject();
      assert.equal((await create({ subject: subject.id })).status, 201);
      for (const empty of [null, '', undefined]) {
        const { status, body } = await create({ subject: empty });
        assert.equal(status, 201);
        assert.equal(body.data.subject, null);
      }
    });

    test('rejects malformed, nonexistent and wrongly-typed subject ids', async () => {
      for (const subject of ['abc', '123', MISSING_ID.slice(1), 123, { $ne: null }, [MISSING_ID]]) {
        const { status, body } = await create({ subject });
        assert.equal(status, 400, `subject ${JSON.stringify(subject)}`);
        assert.equal(body.error.details[0].field, 'subject');
      }
      const missing = await create({ subject: MISSING_ID });
      assert.equal(missing.status, 400);
      assert.match(missing.body.error.message, /does not exist/);
      assert.equal(await countRunAssignments(), 0);
    });

    test('a subject that was deleted can no longer be chosen', async () => {
      const subject = await makeSubject();
      await api.call('DELETE', `/subjects/${subject.id}`);
      assert.equal((await create({ subject: subject.id })).status, 400);
    });

    test('existing assignments keep the correct subject, even when others are added', async () => {
      const [maths, physics] = [await makeSubject('Maths'), await makeSubject('Physics')];
      const a = (await create({ title: testName('A'), subject: maths.id })).body.data;
      const b = (await create({ title: testName('B'), subject: physics.id })).body.data;
      await create({ title: testName('C') });
      assert.equal((await api.call('GET', `/assignments/${a.id}`)).body.data.subject.id, maths.id);
      assert.equal((await api.call('GET', `/assignments/${b.id}`)).body.data.subject.id, physics.id);
    });

    test('renaming a subject shows the new name on its assignments and breaks nothing', async () => {
      const subject = await makeSubject('Maths');
      const created = (await create({ subject: subject.id })).body.data;
      await api.call('PUT', `/subjects/${subject.id}`, { name: testName('Mathematics'), color: '#ff0000' });
      const fetched = (await api.call('GET', `/assignments/${created.id}`)).body.data;
      assert.equal(fetched.subject.id, subject.id);
      assert.equal(fetched.subject.name, testName('Mathematics'));
      assert.equal(fetched.subject.color, '#ff0000');
    });

    test('Phase 3 protection still holds: a subject with an assignment cannot be deleted, and nothing changes', async () => {
      const subject = await makeSubject();
      const assignment = (await create({ subject: subject.id })).body.data;

      const { status, body } = await api.call('DELETE', `/subjects/${subject.id}`);
      assert.equal(status, 409);
      assert.match(body.error.message, /still used by 1 assignment/);
      assert.equal((await api.call('GET', `/subjects/${subject.id}`)).status, 200);
      assert.equal((await api.call('GET', `/assignments/${assignment.id}`)).body.data.subject.id, subject.id);
      assert.deepEqual(await findOrphanedAssignments(), []);
    });

    test('the subject can be deleted once its assignments are deleted or moved away', async () => {
      const [first, second] = [await makeSubject('First'), await makeSubject('Second')];
      const a = (await create({ subject: first.id })).body.data;
      const b = (await create({ subject: first.id })).body.data;
      assert.equal((await api.call('DELETE', `/subjects/${first.id}`)).status, 409);

      await api.call('DELETE', `/assignments/${a.id}`);
      assert.equal((await api.call('DELETE', `/subjects/${first.id}`)).status, 409, 'one assignment is still left');
      await api.call('PUT', `/assignments/${b.id}`, assignmentBody({ subject: second.id }));
      assert.equal((await api.call('DELETE', `/subjects/${first.id}`)).status, 200);
      assert.deepEqual(await findOrphanedAssignments(), []);
    });
  });

  describe('read: get one, list, filter, search, sort, page', () => {
    test('gets one assignment by id; bad ids give 400; unknown ids give 404', async () => {
      const created = (await create()).body.data;
      const { status, body } = await api.call('GET', `/assignments/${created.id}?now=${NOW}`);
      assert.equal(status, 200);
      assert.equal(body.data.title, testName('Essay'));
      assert.equal((await api.call('GET', '/assignments/not-an-id')).status, 400);
      const missing = await api.call('GET', `/assignments/${MISSING_ID}`);
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.message, 'Assignment not found.');
    });

    test('lists nothing sensibly when there are no assignments', async () => {
      const { status, body } = await list();
      assert.equal(status, 200);
      assert.deepEqual(body.data, []);
      assert.deepEqual(body.meta, { total: 0, page: 1, limit: 50 });
    });

    describe('timing (overdue / due soon / upcoming / completed) with now = Wed 2026-10-21 14:30', () => {
      let ids;
      beforeEach(async () => {
        const made = {};
        const add = async (key, fields) => { made[key] = (await create({ title: testName(key), ...fields })).body.data.id; };
        await add('done', { status: 'Completed', dueDate: '2026-10-01' });
        await add('doneToday', { status: 'Completed', dueDate: '2026-10-21', dueTime: '08:00' });
        await add('late', { dueDate: '2026-10-20' });
        await add('lateInProgress', { status: 'In Progress', dueDate: '2026-10-19' });
        await add('todayEarlier', { dueDate: '2026-10-21', dueTime: '09:00' });
        await add('todayLater', { dueDate: '2026-10-21', dueTime: '18:00' });
        await add('todayNoTime', { dueDate: '2026-10-21' });
        await add('soonEdge', { dueDate: '2026-10-24' });
        await add('later', { dueDate: '2026-10-25' });
        ids = made;
      });

      const expectedByTiming = {
        overdue: ['late', 'lateInProgress', 'todayEarlier'],
        dueSoon: ['todayLater', 'todayNoTime', 'soonEdge'],
        upcoming: ['later'],
        completed: ['done', 'doneToday'],
      };

      test('each assignment is labelled with the right timing', async () => {
        const { body } = await list('limit=200');
        const timingOfTitle = Object.fromEntries(body.data.map((a) => [a.title, a.timing]));
        for (const [timing, keys] of Object.entries(expectedByTiming)) {
          for (const key of keys) assert.equal(timingOfTitle[testName(key)], timing, key);
        }
      });

      test('filtering by timing returns exactly that group, and the four groups cover everything once', async () => {
        let total = 0;
        for (const [timing, keys] of Object.entries(expectedByTiming)) {
          const response = await list(`timing=${timing}`);
          assert.deepEqual(titlesOf(response).sort(), keys.map(testName).sort(), timing);
          assert.equal(response.body.meta.total, keys.length);
          total += response.body.meta.total;
        }
        assert.equal(total, Object.keys(ids).length);
      });

      test('completed assignments never appear as pending or overdue', async () => {
        const overdue = titlesOf(await list('timing=overdue'));
        assert.ok(!overdue.includes(testName('done')) && !overdue.includes(testName('doneToday')));
        const pending = [...titlesOf(await list('timing=overdue')), ...titlesOf(await list('timing=dueSoon')), ...titlesOf(await list('timing=upcoming'))];
        assert.equal(pending.length, 7);
        assert.ok(!pending.includes(testName('done')));
      });

      test('marking an overdue assignment complete moves it out of overdue; reopening moves it back', async () => {
        assert.equal((await api.call('PATCH', `/assignments/${ids.late}/status?now=${NOW}`, { status: 'Completed' })).body.data.timing, 'completed');
        assert.ok(!titlesOf(await list('timing=overdue')).includes(testName('late')));
        assert.equal((await api.call('PATCH', `/assignments/${ids.late}/status?now=${NOW}`, { status: 'In Progress' })).body.data.timing, 'overdue');
        assert.ok(titlesOf(await list('timing=overdue')).includes(testName('late')));
      });

      test('the same data is classified differently at a different "now" (no hidden clock use)', async () => {
        const later = await api.call('GET', '/assignments?now=2026-10-26T08:00&timing=overdue&limit=200');
        assert.deepEqual(titlesOf(later).sort(), ['late', 'lateInProgress', 'todayEarlier', 'todayLater', 'todayNoTime', 'soonEdge', 'later'].map(testName).sort());
      });
    });

    describe('filters', () => {
      let maths;
      let physics;
      beforeEach(async () => {
        maths = await makeSubject('Maths');
        physics = await makeSubject('Physics');
        await create({ title: testName('M-high-todo'), subject: maths.id, priority: 'High', status: 'Not Started', dueDate: '2026-10-22' });
        await create({ title: testName('M-low-done'), subject: maths.id, priority: 'Low', status: 'Completed', dueDate: '2026-10-28' });
        await create({ title: testName('P-med-doing'), subject: physics.id, priority: 'Medium', status: 'In Progress', dueDate: '2026-11-02' });
        await create({ title: testName('Loose-high'), priority: 'High', status: 'Not Started', dueDate: '2026-12-01' });
      });
      const names = (response) => titlesOf(response).sort();

      test('by subject, and by "none" for assignments without one', async () => {
        assert.deepEqual(names(await list(`subject=${maths.id}`)), ['M-high-todo', 'M-low-done'].map(testName).sort());
        assert.deepEqual(names(await list(`subject=${physics.id}`)), [testName('P-med-doing')]);
        assert.deepEqual(names(await list('subject=none')), [testName('Loose-high')]);
      });

      test('by status and by priority', async () => {
        assert.deepEqual(names(await list('status=Completed')), [testName('M-low-done')]);
        assert.deepEqual(names(await list('status=In%20Progress')), [testName('P-med-doing')]);
        assert.deepEqual(names(await list('priority=High')), ['Loose-high', 'M-high-todo'].map(testName).sort());
        assert.deepEqual(names(await list('priority=Low')), [testName('M-low-done')]);
      });

      test('by due date range (inclusive)', async () => {
        assert.deepEqual(names(await list('dueFrom=2026-10-28&dueTo=2026-11-02')), ['M-low-done', 'P-med-doing'].map(testName).sort());
        assert.deepEqual(names(await list('dueFrom=2026-11-02')), ['Loose-high', 'P-med-doing'].map(testName).sort());
        assert.deepEqual(names(await list('dueTo=2026-10-22')), [testName('M-high-todo')]);
        assert.deepEqual(names(await list('dueFrom=2027-01-01')), []);
      });

      test('filters combine (AND)', async () => {
        assert.deepEqual(names(await list(`subject=${maths.id}&priority=High`)), [testName('M-high-todo')]);
        assert.deepEqual(names(await list(`subject=${maths.id}&status=In%20Progress`)), []);
        assert.deepEqual(names(await list('priority=High&status=Not%20Started&timing=upcoming')), [testName('Loose-high')]);
      });

      test('search by title is case-insensitive and treats special characters literally', async () => {
        assert.deepEqual(names(await list('q=LOOSE')), [testName('Loose-high')]);
        assert.deepEqual(names(await list('q=m-high')), [testName('M-high-todo')]);
        await create({ title: testName('a.b notes') });
        await create({ title: testName('axb notes') });
        assert.deepEqual(names(await list(`q=${encodeURIComponent('a.b')}`)), [testName('a.b notes')], '"." is not a wildcard');
        assert.deepEqual(names(await list(`q=${encodeURIComponent('(')}`)), [], 'a lone "(" does not crash the search');
        assert.deepEqual(names(await list(`q=${encodeURIComponent('.*')}`)), [], '".*" is not a pattern');
        assert.deepEqual(names(await list('q=nothing-matches-this')), []);
      });

      test('invalid filter values are rejected with 400 instead of being ignored or injected', async () => {
        for (const query of [
          'status=Done', 'priority=Urgent', 'timing=late', 'sort=title', 'order=sideways',
          'dueFrom=2026-02-30', 'dueTo=tomorrow', 'dueFrom=2026-12-01&dueTo=2026-01-01',
          'subject=abc', 'now=today', 'now=2026-10-21', `q=${'x'.repeat(101)}`,
          'status=Completed&status=Not%20Started',
        ]) {
          const { status, body } = await api.call('GET', `/assignments?${query}`);
          assert.equal(status, 400, query);
          assert.equal(body.success, false);
        }
      });

      test('database operators in the query string are never applied', async () => {
        // Express reads "status[$ne]" as an unknown parameter named literally that, so it is ignored.
        // If it were applied as { status: { $ne: 'Completed' } } the completed assignment would be missing.
        const withOperator = await list('status[$ne]=Completed');
        assert.equal(withOperator.status, 200);
        assert.deepEqual(names(withOperator), names(await list('')));
        assert.ok(titlesOf(withOperator).includes(testName('M-low-done')), 'the Completed assignment is still returned');
        assert.equal((await list(`subject[$ne]=${maths.id}`)).body.meta.total, 4);
      });

      test('an empty result is a normal answer, not an error', async () => {
        const { status, body } = await list('status=Completed&priority=High');
        assert.equal(status, 200);
        assert.deepEqual(body.data, []);
        assert.equal(body.meta.total, 0);
      });
    });

    describe('sorting and paging', () => {
      beforeEach(async () => {
        // created one after another so "created" order is A, B, C, D
        await create({ title: testName('A'), dueDate: '2026-10-30', priority: 'Low' });
        await create({ title: testName('B'), dueDate: '2026-10-22', priority: 'High', dueTime: '15:00' });
        await create({ title: testName('C'), dueDate: '2026-10-22', priority: 'High', dueTime: '09:00' });
        await create({ title: testName('D'), dueDate: '2026-10-26', priority: 'Medium' });
      });
      const order = async (query) => (await list(query)).body.data.map((a) => a.title.slice(-1)).join('');

      test('by due date: soonest first by default, ties broken by time of day; reversible', async () => {
        assert.equal(await order(''), 'CBDA');
        assert.equal(await order('sort=dueDate'), 'CBDA');
        assert.equal(await order('sort=dueDate&order=desc'), 'ADBC');
      });

      test('by priority: High first by default; ties broken by due date; reversible', async () => {
        assert.equal(await order('sort=priority'), 'CBDA');
        assert.equal(await order('sort=priority&order=asc'), 'ADCB');
      });

      test('by creation: newest first by default; reversible', async () => {
        assert.equal(await order('sort=createdAt'), 'DCBA');
        assert.equal(await order('sort=createdAt&order=asc'), 'ABCD');
      });

      test('paging returns the right slice and total; limits are capped; nonsense falls back', async () => {
        const page2 = await list('limit=3&page=2');
        assert.equal(page2.body.data.length, 1);
        assert.deepEqual(page2.body.meta, { total: 4, page: 2, limit: 3 });
        assert.equal((await list('limit=999999')).body.meta.limit, 200);
        assert.deepEqual((await list('limit=-1&page=abc')).body.meta, { total: 4, page: 1, limit: 50 });
        assert.equal((await list('page=9')).body.data.length, 0);
      });
    });
  });

  describe('update', () => {
    test('replaces the fields, keeps createdAt, moves updatedAt, and the change persists', async () => {
      const created = (await create({ description: 'old', priority: 'Low' })).body.data;
      await new Promise((resolve) => setTimeout(resolve, 20));

      const { status, body } = await api.call('PUT', `/assignments/${created.id}?now=${NOW}`, assignmentBody({
        title: testName('Renamed'), dueDate: '2026-10-21', dueTime: '10:00', priority: 'High', status: 'In Progress', estimatedMinutes: 30, type: 'Exam',
      }));
      assert.equal(status, 200);
      assert.equal(body.data.title, testName('Renamed'));
      assert.equal(body.data.description, '', 'PUT replaces: omitted optional fields are cleared');
      assert.equal(body.data.timing, 'overdue', 'timing is recomputed for the new due time');
      assert.equal(body.data.createdAt, created.createdAt);
      assert.ok(new Date(body.data.updatedAt) > new Date(created.updatedAt));

      const fetched = (await api.call('GET', `/assignments/${created.id}`)).body.data;
      assert.equal(fetched.title, testName('Renamed'));
      assert.equal(fetched.priority, 'High');
      assert.equal(fetched.estimatedMinutes, 30);
      assert.equal((await storedAssignment(created.id)).priorityRank, 3);
    });

    test('can change, add and clear the subject', async () => {
      const [maths, physics] = [await makeSubject('Maths'), await makeSubject('Physics')];
      const created = (await create({ subject: maths.id })).body.data;
      const put = (subject) => api.call('PUT', `/assignments/${created.id}`, assignmentBody({ subject }));

      assert.equal((await put(physics.id)).body.data.subject.id, physics.id);
      assert.equal((await put(null)).body.data.subject, null);
      assert.equal((await put(maths.id)).body.data.subject.id, maths.id);
    });

    test('invalid updates are rejected and leave the stored assignment unchanged', async () => {
      const subject = await makeSubject();
      const created = (await create({ subject: subject.id, description: 'keep me' })).body.data;
      const before = await storedAssignment(created.id);

      const badPayloads = [
        {}, { title: '   ' }, assignmentBody({ dueDate: '2026-02-30' }), assignmentBody({ priority: 'Urgent' }),
        assignmentBody({ status: 'Done' }), assignmentBody({ estimatedMinutes: -1 }), assignmentBody({ subject: 'abc' }),
        assignmentBody({ subject: MISSING_ID }), assignmentBody({ title: 5 }),
      ];
      for (const payload of badPayloads) {
        const { status } = await api.call('PUT', `/assignments/${created.id}`, payload);
        assert.equal(status, 400, JSON.stringify(payload));
      }
      assert.deepEqual(await storedAssignment(created.id), before);
    });

    test('bad ids give 400; unknown ids give 404', async () => {
      assert.equal((await api.call('PUT', '/assignments/not-an-id', assignmentBody())).status, 400);
      const missing = await api.call('PUT', `/assignments/${MISSING_ID}`, assignmentBody());
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.message, 'Assignment not found.');
    });

    test('quick status change works, validates, and 404s for unknown ids', async () => {
      const created = (await create()).body.data;
      const patch = (id, body) => api.call('PATCH', `/assignments/${id}/status?now=${NOW}`, body);

      const done = await patch(created.id, { status: 'Completed' });
      assert.equal(done.status, 200);
      assert.equal(done.body.data.status, 'Completed');
      assert.equal((await storedAssignment(created.id)).status, 'Completed');
      assert.equal((await storedAssignment(created.id)).title, testName('Essay'), 'nothing else changed');

      for (const bad of [{}, { status: 'Done' }, { status: 5 }, { status: ['Completed'] }, { title: 'x' }]) {
        assert.equal((await patch(created.id, bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await storedAssignment(created.id)).status, 'Completed');
      assert.equal((await patch(MISSING_ID, { status: 'Completed' })).status, 404);
      assert.equal((await patch('nope', { status: 'Completed' })).status, 400);
    });

    test('updating while another request deletes the assignment gives 200 or 404, never a 500', async () => {
      for (let round = 0; round < 5; round += 1) {
        const created = (await create({ title: testName(`Race${round}`) })).body.data;
        const [update, remove] = await Promise.all([
          api.call('PUT', `/assignments/${created.id}`, assignmentBody({ title: testName(`Race${round}b`) })),
          api.call('DELETE', `/assignments/${created.id}`),
        ]);
        assert.ok([200, 404].includes(update.status), `update gave ${update.status}`);
        assert.equal(remove.status, 200);
        assert.equal(await Assignment.countDocuments({ _id: created.id }), 0);
      }
    });
  });

  describe('delete', () => {
    test('deletes an assignment; deleting again gives 404; bad ids give 400', async () => {
      const subject = await makeSubject();
      const created = (await create({ subject: subject.id })).body.data;
      assert.equal((await api.call('DELETE', `/assignments/${created.id}`)).status, 200);
      assert.equal(await countRunAssignments(), 0);
      assert.equal((await api.call('GET', `/assignments/${created.id}`)).status, 404);
      assert.equal((await api.call('DELETE', `/assignments/${created.id}`)).status, 404);
      assert.equal((await api.call('DELETE', '/assignments/not-an-id')).status, 400);
      assert.equal((await api.call('GET', `/subjects/${subject.id}`)).status, 200, 'the subject is untouched');
    });

    test('parallel deletes of one assignment give one 200 and the rest 404', async () => {
      const created = (await create()).body.data;
      const results = await Promise.all(Array.from({ length: 5 }, () => api.call('DELETE', `/assignments/${created.id}`)));
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 404, 404, 404, 404]);
    });
  });

  describe('concurrent creation', () => {
    test('creating many assignments for one subject in parallel all succeed, and the subject is then protected', async () => {
      const subject = await makeSubject();
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => create({ title: testName(`P${i}`), subject: subject.id })));
      assert.ok(results.every((r) => r.status === 201));
      assert.equal(await countRunAssignments(), 10);
      assert.equal((await api.call('DELETE', `/subjects/${subject.id}`)).status, 409);
    });

    test('the subject is never exposed with its internal lock counter', async () => {
      const subject = await makeSubject();
      await create({ subject: subject.id });
      const fetched = (await api.call('GET', `/subjects/${subject.id}`)).body.data;
      assert.equal(fetched.referenceVersion, undefined);
      assert.equal((await api.call('GET', '/subjects')).body.data.some((s) => 'referenceVersion' in s), false);
    });
  });
});
