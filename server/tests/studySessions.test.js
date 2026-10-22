import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Assignment from '../src/models/Assignment.js';
import StudySession from '../src/models/StudySession.js';
import Subject from '../src/models/Subject.js';
import Task from '../src/models/Task.js';
import { findDanglingReferences } from '../src/utils/integrity.js';
import {
  startApiTestServer,
  cleanupRunData,
  countRunSessions,
  findOrphanedSessions,
  testName,
  testDbAvailable,
  RUN_TAG,
} from './helpers/apiTest.js';

const SKIP = testDbAvailable ? false : 'MONGODB_TEST_URI is not set in server/.env';
const MISSING_ID = '64b7f0c2a1b2c3d4e5f60718'; // valid format, but no such record

describe('Study sessions API (database: studyflow_test)', { skip: SKIP }, () => {
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
    maths = await makeSubject('Maths');
  });

  // ---- helpers (every session's NOTES start with the run tag, so cleanup can find it) ----
  const makeSubject = async (label) => (await api.call('POST', '/subjects', { name: testName(label) })).body.data;
  const makeAssignment = async (label = 'Essay', fields = {}) =>
    (await api.call('POST', '/assignments', { title: testName(label), dueDate: '2026-11-01', ...fields })).body.data;
  const sessionBody = (fields = {}) => ({ subject: maths.id, date: '2026-10-21', durationMinutes: 60, notes: testName('note'), ...fields });
  const create = (fields) => api.call('POST', '/study-sessions', sessionBody(fields));
  const list = (query = '') => api.call('GET', `/study-sessions${query ? `?${query}` : ''}`);
  const summary = (query = '') => api.call('GET', `/study-sessions/summary${query ? `?${query}` : ''}`);
  const notesOf = (response) => response.body.data.map((s) => s.notes.replace(`${RUN_TAG}_`, ''));
  const stored = (id) => mongoose.connection.collection('studysessions').findOne({ _id: new mongoose.Types.ObjectId(id) });

  describe('create', () => {
    test('creates a session with every field and populated subject and assignment', async () => {
      const assignment = await makeAssignment();
      const { status, body } = await create({
        assignment: assignment.id, date: '2026-10-22', startTime: '14:30', durationMinutes: 90, notes: testName('Chapter 3'), type: 'Revision',
      });
      assert.equal(status, 201);
      const s = body.data;
      assert.equal(s.subject.id, maths.id);
      assert.equal(s.subject.name, maths.name);
      assert.equal(s.assignment.id, assignment.id);
      assert.equal(s.assignment.title, assignment.title);
      assert.equal(s.date, '2026-10-22');
      assert.equal(s.startTime, '14:30');
      assert.equal(s.durationMinutes, 90);
      assert.equal(s.type, 'Revision');
      assert.ok(s.id && s.createdAt && s.updatedAt);
      assert.equal(s._id, undefined);
      assert.equal(s.__v, undefined);
    });

    test('a minimal session (subject, date, duration) gets sensible defaults', async () => {
      const { status, body } = await api.call('POST', '/study-sessions', { subject: maths.id, date: '2026-10-21', durationMinutes: 25, notes: testName('min') });
      assert.equal(status, 201);
      assert.equal(body.data.assignment, null);
      assert.equal(body.data.startTime, '');
      assert.equal(body.data.type, '');
    });

    test('persists what was sent, with the date as plain text', async () => {
      const { body } = await create({ date: '2031-03-09', startTime: '07:05', durationMinutes: 45 });
      const row = await stored(body.data.id);
      assert.equal(row.date, '2031-03-09');
      assert.equal(row.startTime, '07:05');
      assert.equal(row.durationMinutes, 45);
      assert.equal(row.subject.toString(), maths.id);
      assert.equal(row.assignment, null);
    });

    test('durations: whole minutes from 1 to 1440 are accepted (also as digit strings); everything else is rejected', async () => {
      for (const ok of [1, 25, 1440, '90']) assert.equal((await create({ durationMinutes: ok })).status, 201, `duration ${JSON.stringify(ok)}`);
      assert.equal((await create({ durationMinutes: '90' })).body.data.durationMinutes, 90, 'a digit string is stored as a number');
      for (const bad of [0, -1, -60, 1.5, 0.5, 1441, 100000, 'abc', '1.5', '-5', '', null, undefined, true, {}, [60], { $gt: 0 }, NaN]) {
        const { status, body } = await create({ durationMinutes: bad });
        assert.equal(status, 400, `duration ${JSON.stringify(bad)}`);
        assert.equal(body.error.details[0].field, 'durationMinutes');
      }
    });

    test('the subject is REQUIRED and must exist', async () => {
      for (const subject of [undefined, null, '']) {
        const { status, body } = await create({ subject });
        assert.equal(status, 400, `subject ${JSON.stringify(subject)}`);
        assert.equal(body.error.details[0].field, 'subject');
        assert.match(body.error.details[0].message, /required/);
      }
      for (const subject of ['abc', '123', MISSING_ID.slice(1), 123, { $ne: null }, [MISSING_ID]]) {
        const { status, body } = await create({ subject });
        assert.equal(status, 400, `subject ${JSON.stringify(subject)}`);
        assert.equal(body.error.details[0].field, 'subject');
      }
      const missing = await create({ subject: MISSING_ID });
      assert.equal(missing.status, 400);
      assert.match(missing.body.error.message, /selected subject does not exist/);
      assert.equal(await countRunSessions(), 0);
    });

    test('the assignment is optional, but if given it must be valid and exist', async () => {
      for (const value of [null, '', undefined]) assert.equal((await create({ assignment: value })).status, 201);
      for (const assignment of ['abc', 123, { $ne: null }, [MISSING_ID]]) {
        const { status, body } = await create({ assignment });
        assert.equal(status, 400, `assignment ${JSON.stringify(assignment)}`);
        assert.equal(body.error.details[0].field, 'assignment');
      }
      const missing = await create({ assignment: MISSING_ID });
      assert.equal(missing.status, 400);
      assert.match(missing.body.error.message, /selected assignment does not exist/);
    });

    test('rejects missing and impossible dates, bad times, bad types and bad notes', async () => {
      const missing = await api.call('POST', '/study-sessions', { subject: maths.id, durationMinutes: 30 });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error.details[0].field, 'date');
      const cases = [
        ['date', '2026-02-30'], ['date', '2025-02-29'], ['date', '2026-13-01'], ['date', '26-10-25'], ['date', 20261025], ['date', '1999-12-31'], ['date', '2101-01-01'],
        ['startTime', '24:00'], ['startTime', '9:30'], ['startTime', '12:60'], ['startTime', 1230],
        ['type', 'Cramming'], ['type', 5], ['notes', 'x'.repeat(1001)], ['notes', 5],
      ];
      for (const [field, value] of cases) {
        const { status, body } = await create({ [field]: value });
        assert.equal(status, 400, `${field} = ${JSON.stringify(value)}`);
        assert.equal(body.error.details[0].field, field);
      }
      assert.equal((await create({ date: '2028-02-29' })).status, 201, 'a real leap day is fine');
      assert.equal((await create({ date: '2030-06-01' })).status, 201, 'a future (planned) session is allowed');
    });

    test('reports every problem at once', async () => {
      const { status, body } = await api.call('POST', '/study-sessions', { date: 'nope', durationMinutes: 0, type: 'x' });
      assert.equal(status, 400);
      assert.deepEqual(body.error.details.map((d) => d.field).sort(), ['date', 'durationMinutes', 'subject', 'type']);
    });

    test('invalid requests never create records', async () => {
      for (const payload of [{}, { subject: maths.id }, { date: '2026-10-21', durationMinutes: 30 }, { subject: maths.id, date: '2026-10-21' }, { subject: maths.id, date: '2026-10-21', durationMinutes: -5 }]) {
        assert.equal((await api.call('POST', '/study-sessions', { ...payload })).status, 400);
      }
      assert.equal(await mongoose.connection.collection('studysessions').countDocuments({}), 0);
    });

    test('ignores fields users must not set (mass assignment)', async () => {
      const { status, body } = await create({ _id: MISSING_ID, createdAt: '2000-01-01T00:00:00.000Z', $set: { durationMinutes: 1 }, isAdmin: true });
      assert.equal(status, 201);
      assert.notEqual(body.data.id, MISSING_ID);
      assert.notEqual(body.data.createdAt, '2000-01-01T00:00:00.000Z');
      assert.equal(body.data.isAdmin, undefined);
      assert.equal(body.data.durationMinutes, 60);
    });

    test('an assignment from a different subject is allowed (the session simply records study time for its own subject)', async () => {
      const physics = await makeSubject('Physics');
      const assignment = await makeAssignment('Lab', { subject: physics.id });
      const { status, body } = await create({ assignment: assignment.id });
      assert.equal(status, 201);
      assert.equal(body.data.subject.id, maths.id);
      assert.equal(body.data.assignment.id, assignment.id);
    });

    test('there is no login in this app (authorization: not applicable)', async () => {
      assert.equal((await list()).status, 200);
    });
  });

  describe('read: get one, list, filter, search, sort, page', () => {
    test('gets one session by id; bad ids give 400; unknown ids give 404', async () => {
      const created = (await create()).body.data;
      const { status, body } = await api.call('GET', `/study-sessions/${created.id}`);
      assert.equal(status, 200);
      assert.equal(body.data.durationMinutes, 60);
      assert.equal((await api.call('GET', '/study-sessions/not-an-id')).status, 400);
      const missing = await api.call('GET', `/study-sessions/${MISSING_ID}`);
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.message, 'Study session not found.');
    });

    test('lists nothing sensibly when there are no sessions', async () => {
      const { status, body } = await list();
      assert.equal(status, 200);
      assert.deepEqual(body.data, []);
      assert.deepEqual(body.meta, { total: 0, page: 1, limit: 50 });
    });

    describe('filters', () => {
      let physics;
      let assignment;
      beforeEach(async () => {
        physics = await makeSubject('Physics');
        assignment = await makeAssignment();
        await create({ notes: testName('M-read'), date: '2026-10-20', durationMinutes: 30, type: 'Reading' });
        await create({ notes: testName('M-practice'), date: '2026-10-21', durationMinutes: 45, type: 'Practice', assignment: assignment.id });
        await create({ notes: testName('P-revise'), subject: physics.id, date: '2026-10-22', durationMinutes: 90, type: 'Revision' });
        await create({ notes: testName('P-plain'), subject: physics.id, date: '2026-10-25', durationMinutes: 15 });
      });
      const names = (response) => notesOf(response).sort();

      test('by one day, by date range (inclusive)', async () => {
        assert.deepEqual(names(await list('date=2026-10-21')), ['M-practice']);
        assert.deepEqual(names(await list('dateFrom=2026-10-21&dateTo=2026-10-22')), ['M-practice', 'P-revise']);
        assert.deepEqual(names(await list('dateFrom=2026-10-23')), ['P-plain']);
        assert.deepEqual(names(await list('dateTo=2026-10-20')), ['M-read']);
        assert.deepEqual(names(await list('dateFrom=2027-01-01')), []);
      });

      test('by subject, by assignment, and by "none"', async () => {
        assert.deepEqual(names(await list(`subject=${maths.id}`)), ['M-practice', 'M-read']);
        assert.deepEqual(names(await list(`subject=${physics.id}`)), ['P-plain', 'P-revise']);
        assert.deepEqual(names(await list(`assignment=${assignment.id}`)), ['M-practice']);
        assert.deepEqual(names(await list('assignment=none')), ['M-read', 'P-plain', 'P-revise']);
      });

      test('by type, and filters combine (AND)', async () => {
        assert.deepEqual(names(await list('type=Revision')), ['P-revise']);
        assert.deepEqual(names(await list(`subject=${maths.id}&type=Practice`)), ['M-practice']);
        assert.deepEqual(names(await list(`subject=${physics.id}&type=Reading`)), []);
        assert.deepEqual(names(await list(`subject=${physics.id}&dateFrom=2026-10-23`)), ['P-plain']);
      });

      test('search in the notes is case-insensitive and treats special characters literally', async () => {
        assert.deepEqual(names(await list('q=REVISE')), ['P-revise']);
        await create({ notes: testName('a.b chapter') });
        await create({ notes: testName('axb chapter') });
        assert.deepEqual(names(await list(`q=${encodeURIComponent('a.b')}`)), ['a.b chapter'], '"." is not a wildcard');
        assert.deepEqual(names(await list(`q=${encodeURIComponent('(')}`)), []);
        assert.deepEqual(names(await list(`q=${encodeURIComponent('.*')}`)), []);
      });

      test('invalid filter values are rejected with 400', async () => {
        for (const query of [
          'type=Cramming', 'sort=title', 'order=sideways', 'date=2026-02-30', 'dateFrom=tomorrow', 'dateFrom=2026-12-01&dateTo=2026-01-01',
          'subject=abc', 'subject=none', 'assignment=abc', `q=${'x'.repeat(101)}`, 'type=Reading&type=Practice',
        ]) {
          const { status, body } = await api.call('GET', `/study-sessions?${query}`);
          assert.equal(status, 400, query);
          assert.equal(body.success, false);
        }
      });

      test('database operators in the query string are never applied', async () => {
        const withOperator = await list('type[$ne]=Reading');
        assert.equal(withOperator.status, 200);
        assert.deepEqual(names(withOperator), names(await list('')));
        assert.ok(notesOf(withOperator).includes('M-read'));
      });
    });

    describe('sorting and paging', () => {
      beforeEach(async () => {
        await create({ notes: testName('A'), date: '2026-10-22', startTime: '15:00', durationMinutes: 30 });
        await create({ notes: testName('B'), date: '2026-10-22', startTime: '09:00', durationMinutes: 90 });
        await create({ notes: testName('C'), date: '2026-10-22', durationMinutes: 10 });
        await create({ notes: testName('D'), date: '2026-10-21', startTime: '20:00', durationMinutes: 60 });
        await create({ notes: testName('E'), date: '2026-10-23', startTime: '08:00', durationMinutes: 5 });
      });
      const order = async (query) => (await list(query)).body.data.map((s) => s.notes.slice(-1)).join('');

      test('by date: newest first by default (later start first, untimed last); reversible', async () => {
        assert.equal(await order(''), 'EABCD');
        assert.equal(await order('sort=date&order=asc'), 'DCBAE');
      });

      test('by duration: longest first by default; reversible', async () => {
        assert.equal(await order('sort=duration'), 'BDACE');
        assert.equal(await order('sort=duration&order=asc'), 'ECADB');
      });

      test('by creation: newest first by default; reversible', async () => {
        assert.equal(await order('sort=createdAt'), 'EDCBA');
        assert.equal(await order('sort=createdAt&order=asc'), 'ABCDE');
      });

      test('paging returns the right slice and total; limits are capped; nonsense falls back', async () => {
        const page3 = await list('limit=2&page=3');
        assert.equal(page3.body.data.length, 1);
        assert.deepEqual(page3.body.meta, { total: 5, page: 3, limit: 2 });
        assert.equal((await list('limit=999999')).body.meta.limit, 200);
        assert.deepEqual((await list('limit=-1&page=abc')).body.meta, { total: 5, page: 1, limit: 50 });
      });
    });
  });

  describe('study-time summary (always calculated from the stored sessions)', () => {
    let physics;
    beforeEach(async () => {
      physics = await makeSubject('Physics');
      await create({ notes: testName('s1'), date: '2026-10-20', durationMinutes: 60 });
      await create({ notes: testName('s2'), date: '2026-10-21', durationMinutes: 30, type: 'Reading' });
      await create({ notes: testName('s3'), date: '2026-10-21', durationMinutes: 45 });
      await create({ notes: testName('s4'), subject: physics.id, date: '2026-10-21', durationMinutes: 90, type: 'Reading' });
    });

    test('totals, per-day and per-subject figures match the stored sessions exactly', async () => {
      const { status, body } = await summary();
      assert.equal(status, 200);
      const d = body.data;
      assert.equal(d.totalMinutes, 225);
      assert.equal(d.sessionCount, 4);
      assert.deepEqual(d.byDay, [{ date: '2026-10-20', minutes: 60, sessions: 1 }, { date: '2026-10-21', minutes: 165, sessions: 3 }]);
      assert.deepEqual(d.bySubject.map((s) => [s.subject.name, s.minutes, s.sessions]), [[maths.name, 135, 3], [physics.name, 90, 1]]);
      assert.equal(d.bySubject[0].subject.id, maths.id);
      assert.equal(d.bySubject[0].subject.color, '#4f46e5');
      assert.equal(d.byDay.reduce((sum, row) => sum + row.minutes, 0), d.totalMinutes, 'per-day figures add up to the total');
      assert.equal(d.bySubject.reduce((sum, row) => sum + row.minutes, 0), d.totalMinutes, 'per-subject figures add up to the total');
    });

    test('the summary follows the same filters as the list', async () => {
      assert.equal((await summary('date=2026-10-21')).body.data.totalMinutes, 165);
      assert.equal((await summary('dateFrom=2026-10-21&dateTo=2026-10-21')).body.data.sessionCount, 3);
      assert.equal((await summary(`subject=${physics.id}`)).body.data.totalMinutes, 90);
      assert.equal((await summary('type=Reading')).body.data.totalMinutes, 120);
      assert.equal((await summary(`subject=${maths.id}&dateFrom=2026-10-21`)).body.data.totalMinutes, 75);
      const listTotal = (await list('type=Reading')).body.data.reduce((sum, s) => sum + s.durationMinutes, 0);
      assert.equal(listTotal, (await summary('type=Reading')).body.data.totalMinutes, 'list and summary agree');
    });

    test('with no matching sessions the answer is zeros and empty lists (nothing is divided or invented)', async () => {
      const { status, body } = await summary('date=2027-01-01');
      assert.equal(status, 200);
      assert.deepEqual(body.data, { totalMinutes: 0, sessionCount: 0, byDay: [], bySubject: [] });
    });

    test('totals change when sessions are edited, added or deleted', async () => {
      const first = (await list('date=2026-10-20')).body.data[0];
      assert.equal((await api.call('PUT', `/study-sessions/${first.id}`, sessionBody({ date: '2026-10-20', durationMinutes: 100, notes: first.notes }))).status, 200);
      assert.equal((await summary()).body.data.totalMinutes, 265);
      const added = (await create({ notes: testName('s5'), durationMinutes: 35 })).body.data;
      assert.equal((await summary()).body.data.totalMinutes, 300);
      await api.call('DELETE', `/study-sessions/${added.id}`);
      await api.call('DELETE', `/study-sessions/${first.id}`);
      const after = (await summary()).body.data;
      assert.equal(after.totalMinutes, 165);
      assert.equal(after.sessionCount, 3);
    });

    test('the summary route is not mistaken for an id, and invalid filters are rejected', async () => {
      assert.equal((await api.call('GET', '/study-sessions/summary')).status, 200);
      for (const query of ['date=2026-02-30', 'subject=abc', 'type=Cramming', 'dateFrom=2026-12-01&dateTo=2026-01-01', 'subject=none']) {
        assert.equal((await summary(query)).status, 400, query);
      }
    });
  });

  describe('update', () => {
    test('replaces the fields, keeps createdAt, moves updatedAt, and the change persists', async () => {
      const created = (await create({ startTime: '10:00', type: 'Reading' })).body.data;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const { status, body } = await api.call('PUT', `/study-sessions/${created.id}`, sessionBody({ date: '2026-10-22', durationMinutes: 120, notes: testName('changed') }));
      assert.equal(status, 200);
      assert.equal(body.data.durationMinutes, 120);
      assert.equal(body.data.startTime, '', 'PUT replaces: omitted optional fields are cleared');
      assert.equal(body.data.type, '');
      assert.equal(body.data.createdAt, created.createdAt);
      assert.ok(new Date(body.data.updatedAt) > new Date(created.updatedAt));
      const row = await stored(created.id);
      assert.equal(row.date, '2026-10-22');
      assert.equal(row.durationMinutes, 120);
    });

    test('can change the subject, and add, change and clear the assignment', async () => {
      const [physics, one, two] = [await makeSubject('Physics'), await makeAssignment('One'), await makeAssignment('Two')];
      const created = (await create()).body.data;
      const put = (fields) => api.call('PUT', `/study-sessions/${created.id}`, sessionBody(fields));

      assert.equal((await put({ subject: physics.id })).body.data.subject.id, physics.id);
      assert.equal((await put({ assignment: one.id })).body.data.assignment.id, one.id);
      assert.equal((await put({ assignment: two.id })).body.data.assignment.id, two.id);
      assert.equal((await put({})).body.data.assignment, null);
    });

    test('the subject cannot be removed from a session', async () => {
      const created = (await create()).body.data;
      for (const subject of [null, '', undefined]) {
        const { status, body } = await api.call('PUT', `/study-sessions/${created.id}`, sessionBody({ subject }));
        assert.equal(status, 400);
        assert.equal(body.error.details[0].field, 'subject');
      }
      assert.equal((await stored(created.id)).subject.toString(), maths.id);
    });

    test('invalid updates are rejected and leave the stored session unchanged', async () => {
      const assignment = await makeAssignment();
      const created = (await create({ assignment: assignment.id, notes: testName('keep') })).body.data;
      const before = await stored(created.id);
      const badPayloads = [
        {}, sessionBody({ durationMinutes: 0 }), sessionBody({ durationMinutes: 'abc' }), sessionBody({ date: '2026-02-30' }), sessionBody({ startTime: '25:00' }),
        sessionBody({ type: 'Cramming' }), sessionBody({ subject: 'abc' }), sessionBody({ subject: MISSING_ID }), sessionBody({ assignment: MISSING_ID }), sessionBody({ notes: 5 }),
      ];
      for (const payload of badPayloads) assert.equal((await api.call('PUT', `/study-sessions/${created.id}`, payload)).status, 400, JSON.stringify(payload));
      assert.deepEqual(await stored(created.id), before);
    });

    test('bad ids give 400; unknown ids give 404', async () => {
      assert.equal((await api.call('PUT', '/study-sessions/not-an-id', sessionBody())).status, 400);
      const missing = await api.call('PUT', `/study-sessions/${MISSING_ID}`, sessionBody());
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.message, 'Study session not found.');
    });

    test('updating while another request deletes the session gives 200 or 404, never a 500', async () => {
      for (let round = 0; round < 5; round += 1) {
        const created = (await create({ notes: testName(`Race${round}`) })).body.data;
        const [update, remove] = await Promise.all([
          api.call('PUT', `/study-sessions/${created.id}`, sessionBody({ notes: testName(`Race${round}b`) })),
          api.call('DELETE', `/study-sessions/${created.id}`),
        ]);
        assert.ok([200, 404].includes(update.status), `update gave ${update.status}`);
        assert.equal(remove.status, 200);
      }
    });
  });

  describe('delete', () => {
    test('deletes a session; deleting again gives 404; bad ids give 400; its subject and assignment are untouched', async () => {
      const assignment = await makeAssignment();
      const created = (await create({ assignment: assignment.id })).body.data;
      assert.equal((await api.call('DELETE', `/study-sessions/${created.id}`)).status, 200);
      assert.equal(await countRunSessions(), 0);
      assert.equal((await api.call('GET', `/study-sessions/${created.id}`)).status, 404);
      assert.equal((await api.call('DELETE', `/study-sessions/${created.id}`)).status, 404);
      assert.equal((await api.call('DELETE', '/study-sessions/not-an-id')).status, 400);
      assert.equal((await api.call('GET', `/subjects/${maths.id}`)).status, 200);
      assert.equal((await api.call('GET', `/assignments/${assignment.id}`)).status, 200);
    });

    test('parallel deletes of one session give one 200 and the rest 404', async () => {
      const created = (await create()).body.data;
      const results = await Promise.all(Array.from({ length: 5 }, () => api.call('DELETE', `/study-sessions/${created.id}`)));
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 404, 404, 404, 404]);
    });
  });

  describe('integration with subjects, assignments and tasks (earlier behaviour must still hold)', () => {
    test('a subject with sessions cannot be deleted, and nothing changes; it can once the sessions are gone', async () => {
      const a = (await create()).body.data;
      const b = (await create()).body.data;
      const blocked = await api.call('DELETE', `/subjects/${maths.id}`);
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error.message, /still used by 2 study sessions/);
      assert.equal((await api.call('GET', `/subjects/${maths.id}`)).status, 200);

      await api.call('DELETE', `/study-sessions/${a.id}`);
      assert.equal((await api.call('DELETE', `/subjects/${maths.id}`)).status, 409, 'one session is left');
      await api.call('DELETE', `/study-sessions/${b.id}`);
      assert.equal((await api.call('DELETE', `/subjects/${maths.id}`)).status, 200);
      assert.deepEqual(await findOrphanedSessions(), []);
    });

    test('moving a session to another subject frees the first subject for deletion', async () => {
      const physics = await makeSubject('Physics');
      const session = (await create()).body.data;
      assert.equal((await api.call('DELETE', `/subjects/${maths.id}`)).status, 409);
      await api.call('PUT', `/study-sessions/${session.id}`, sessionBody({ subject: physics.id }));
      assert.equal((await api.call('DELETE', `/subjects/${maths.id}`)).status, 200);
      assert.equal((await api.call('DELETE', `/subjects/${physics.id}`)).status, 409);
    });

    test('the delete message counts assignments, tasks and sessions together', async () => {
      await makeAssignment('Essay', { subject: maths.id });
      await api.call('POST', '/tasks', { title: testName('T'), date: '2026-10-25', subject: maths.id });
      await create();
      const { status, body } = await api.call('DELETE', `/subjects/${maths.id}`);
      assert.equal(status, 409);
      assert.match(body.error.message, /1 assignment, 1 task and 1 study session/);
    });

    test('deleting an assignment keeps its sessions and clears their link (other sessions are untouched)', async () => {
      const [assignment, other] = [await makeAssignment('Doomed'), await makeAssignment('Other')];
      const linked = (await create({ notes: testName('linked'), assignment: assignment.id })).body.data;
      const untouchedA = (await create({ notes: testName('other link'), assignment: other.id })).body.data;
      const untouchedB = (await create({ notes: testName('no link') })).body.data;
      const before = await Promise.all([untouchedA, untouchedB].map((s) => stored(s.id)));
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal((await api.call('DELETE', `/assignments/${assignment.id}`)).status, 200);

      const after = (await api.call('GET', `/study-sessions/${linked.id}`)).body.data;
      assert.equal(after.assignment, null, 'the link was cleared');
      assert.equal(after.durationMinutes, 60, 'the session itself still exists, unchanged');
      assert.equal(after.subject.id, maths.id);
      assert.ok(new Date(after.updatedAt) > new Date(linked.updatedAt));
      assert.deepEqual(await Promise.all([untouchedA, untouchedB].map((s) => stored(s.id))), before);
      assert.deepEqual(await findOrphanedSessions(), []);
    });

    test('study time is unaffected when the assignment it was linked to is deleted', async () => {
      const assignment = await makeAssignment();
      await create({ assignment: assignment.id, durationMinutes: 40 });
      const before = (await summary()).body.data.totalMinutes;
      await api.call('DELETE', `/assignments/${assignment.id}`);
      assert.equal((await summary()).body.data.totalMinutes, before);
    });

    test('renaming a subject shows the new name on its sessions and in the summary', async () => {
      const session = (await create()).body.data;
      await api.call('PUT', `/subjects/${maths.id}`, { name: testName('Mathematics'), color: '#ff0000' });
      const fetched = (await api.call('GET', `/study-sessions/${session.id}`)).body.data;
      assert.equal(fetched.subject.name, testName('Mathematics'));
      assert.equal(fetched.subject.color, '#ff0000');
      assert.equal((await summary()).body.data.bySubject[0].subject.name, testName('Mathematics'));
    });

    test('the integrity checker covers session links', async () => {
      await create();
      assert.deepEqual(await findDanglingReferences(), []);
      const missing = new mongoose.Types.ObjectId();
      const { insertedId } = await mongoose.connection.collection('studysessions').insertOne({ subject: new mongoose.Types.ObjectId(maths.id), assignment: missing, notes: testName('damaged'), date: '2026-10-21', durationMinutes: 5 });
      assert.deepEqual(await findDanglingReferences(), [{ collection: 'studysessions', id: insertedId.toString(), field: 'assignment', missing: missing.toString() }]);
    });

    test('hidden lock counters are never exposed', async () => {
      const assignment = await makeAssignment();
      const session = (await create({ assignment: assignment.id })).body.data;
      assert.equal(session.assignment.referenceVersion, undefined);
      assert.equal(session.subject.referenceVersion, undefined);
      assert.equal((await list()).body.data.some((s) => 'referenceVersion' in s.subject), false);
    });
  });
});
