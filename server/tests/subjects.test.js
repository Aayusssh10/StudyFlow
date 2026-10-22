import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Subject from '../src/models/Subject.js';
import {
  startApiTestServer,
  cleanupRunData,
  countRunSubjects,
  insertReference,
  testName,
  testDbAvailable,
} from './helpers/apiTest.js';

const SKIP = testDbAvailable ? false : 'MONGODB_TEST_URI is not set in server/.env';
const MISSING_ID = '64b7f0c2a1b2c3d4e5f60718'; // valid format, but no such record
const MATH = testName('Mathematics');

describe('Subjects API (database: studyflow_test)', { skip: SKIP }, () => {
  let api;

  before(async () => {
    api = await startApiTestServer();
    await Subject.init(); // make sure the unique name index exists
  });
  after(async () => {
    await cleanupRunData();
    await api.close();
  });
  beforeEach(cleanupRunData);

  const createSubject = (fields = {}) => api.call('POST', '/subjects', { name: MATH, ...fields });

  describe('create', () => {
    test('creates a subject with defaults and timestamps', async () => {
      const { status, body } = await createSubject();
      assert.equal(status, 201);
      assert.equal(body.success, true);
      assert.equal(body.data.name, MATH);
      assert.equal(body.data.color, '#4f46e5');
      assert.equal(body.data.code, '');
      assert.ok(body.data.id);
      assert.equal(body.data._id, undefined);
      assert.equal(body.data.__v, undefined);
      assert.ok(body.data.createdAt && body.data.updatedAt);
    });

    test('saves all optional fields and trims whitespace', async () => {
      const { status, body } = await createSubject({
        name: `  ${testName('Physics')}  `,
        code: ' PHY101 ',
        instructor: 'Dr. Rao',
        description: 'Mechanics',
        color: '#FF0000',
      });
      assert.equal(status, 201);
      assert.equal(body.data.name, testName('Physics'));
      assert.equal(body.data.code, 'PHY101');
      assert.equal(body.data.instructor, 'Dr. Rao');
      assert.equal(body.data.description, 'Mechanics');
      assert.equal(body.data.color, '#ff0000');
    });

    test('rejects a missing name', async () => {
      const { status, body } = await api.call('POST', '/subjects', { code: 'X' });
      assert.equal(status, 400);
      assert.equal(body.error.details[0].field, 'name');
    });

    test('rejects a blank (spaces only) name', async () => {
      const { status, body } = await createSubject({ name: '    ' });
      assert.equal(status, 400);
      assert.match(body.error.details[0].message, /cannot be blank/);
    });

    test('rejects a name that is not text (including database operator objects)', async () => {
      for (const bad of [123, { $ne: null }, ['a'], true]) {
        const { status } = await createSubject({ name: bad });
        assert.equal(status, 400, `name ${JSON.stringify(bad)} should be rejected`);
      }
    });

    test('rejects too-long values, wrong types and invalid colors', async () => {
      assert.equal((await createSubject({ name: 'x'.repeat(101) })).status, 400);
      assert.equal((await createSubject({ code: 'x'.repeat(21) })).status, 400);
      assert.equal((await createSubject({ description: 'x'.repeat(501) })).status, 400);
      assert.equal((await createSubject({ instructor: 'x'.repeat(101) })).status, 400);
      assert.equal((await createSubject({ code: 42 })).status, 400);
      assert.equal((await createSubject({ instructor: { $gt: '' } })).status, 400);
      for (const color of ['red', '#12345', '#GGGGGG', 123, { a: 1 }]) {
        const result = await createSubject({ color });
        assert.equal(result.status, 400, `color ${JSON.stringify(color)} should be rejected`);
        assert.equal(result.body.error.details[0].field, 'color');
      }
    });

    test('invalid requests never create records', async () => {
      const badPayloads = [
        {},
        { name: '' },
        { name: '   ' },
        { name: 5 },
        { name: MATH, color: 'red' },
        { name: MATH, code: 'x'.repeat(21) },
      ];
      for (const payload of badPayloads) {
        const { status } = await api.call('POST', '/subjects', payload);
        assert.equal(status, 400, `payload ${JSON.stringify(payload)}`);
      }
      assert.equal(await countRunSubjects(), 0);
      assert.equal(await mongoose.connection.collection('subjects').countDocuments({}), 0);
    });

    test('reports every validation problem at once', async () => {
      const { body } = await api.call('POST', '/subjects', { name: '', color: 'nope' });
      const fields = body.error.details.map((d) => d.field).sort();
      assert.deepEqual(fields, ['color', 'name']);
    });

    test('ignores fields users must not set (mass assignment)', async () => {
      const { status, body } = await createSubject({
        _id: MISSING_ID,
        createdAt: '2000-01-01T00:00:00.000Z',
        $set: { name: 'hacked' },
        isAdmin: true,
      });
      assert.equal(status, 201);
      assert.notEqual(body.data.id, MISSING_ID);
      assert.notEqual(body.data.createdAt, '2000-01-01T00:00:00.000Z');
      assert.equal(body.data.isAdmin, undefined);
      assert.equal(body.data.name, MATH);
    });

    test('rejects a duplicate name, ignoring upper/lower case', async () => {
      await createSubject({ name: testName('Chemistry') });
      const { status, body } = await createSubject({ name: testName('Chemistry').toUpperCase() });
      assert.equal(status, 409);
      assert.equal(body.success, false);
      assert.equal(body.error.details[0].field, 'name');
      assert.equal(await countRunSubjects(), 1);
    });

    test('parallel creation of the same name yields exactly one subject (no 500s)', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => createSubject({ name: testName('Parallel') })));
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409, 409, 409]);
      assert.equal(await countRunSubjects(), 1);
    });
  });

  describe('read', () => {
    test('lists subjects sorted by name with paging info', async () => {
      for (const label of ['banana', 'Apple', 'Cherry']) await createSubject({ name: testName(label) });

      const { status, body } = await api.call('GET', '/subjects');
      assert.equal(status, 200);
      assert.deepEqual(body.data.map((s) => s.name), ['Apple', 'banana', 'Cherry'].map(testName));
      assert.deepEqual(body.meta, { total: 3, page: 1, limit: 100 });
    });

    test('supports page and limit, and ignores nonsense values', async () => {
      for (const label of ['A', 'B', 'C']) await createSubject({ name: testName(label) });

      const page2 = await api.call('GET', '/subjects?limit=2&page=2');
      assert.deepEqual(page2.body.data.map((s) => s.name), [testName('C')]);
      assert.equal(page2.body.meta.total, 3);

      const nonsense = await api.call('GET', '/subjects?limit=-5&page=abc');
      assert.equal(nonsense.status, 200);
      assert.deepEqual(nonsense.body.meta, { total: 3, page: 1, limit: 100 });

      const huge = await api.call('GET', '/subjects?limit=999999');
      assert.equal(huge.body.meta.limit, 200, 'limit is capped');
    });

    test('returns an empty list when there are no subjects', async () => {
      const { status, body } = await api.call('GET', '/subjects');
      assert.equal(status, 200);
      assert.deepEqual(body.data, []);
      assert.equal(body.meta.total, 0);
    });

    test('gets one subject by id', async () => {
      const created = (await createSubject()).body.data;
      const { status, body } = await api.call('GET', `/subjects/${created.id}`);
      assert.equal(status, 200);
      assert.equal(body.data.name, MATH);
    });

    test('invalid ids return 400 and unknown ids return 404', async () => {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const body = method === 'PUT' ? { name: 'x' } : undefined; // only PUT has a body
        const bad = await api.call(method, '/subjects/not-an-id', body);
        assert.equal(bad.status, 400, `${method} with a bad id`);
        const missing = await api.call(method, `/subjects/${MISSING_ID}`, body);
        assert.equal(missing.status, 404, `${method} with an unknown id`);
        assert.equal(missing.body.error.message, 'Subject not found.');
      }
    });
  });

  describe('update', () => {
    test('updates fields, keeps createdAt and moves updatedAt forward', async () => {
      const created = (await createSubject({ code: 'M1' })).body.data;
      await new Promise((resolve) => setTimeout(resolve, 20));

      const { status, body } = await api.call('PUT', `/subjects/${created.id}`, {
        name: testName('Advanced Mathematics'),
        instructor: 'Prof. Iyer',
        color: '#00ff00',
      });
      assert.equal(status, 200);
      assert.equal(body.data.name, testName('Advanced Mathematics'));
      assert.equal(body.data.instructor, 'Prof. Iyer');
      assert.equal(body.data.code, ''); // PUT replaces: omitted optional fields are cleared
      assert.equal(body.data.createdAt, created.createdAt);
      assert.ok(new Date(body.data.updatedAt) > new Date(created.updatedAt));
    });

    test('changes persist when the subject is fetched again', async () => {
      const created = (await createSubject()).body.data;
      await api.call('PUT', `/subjects/${created.id}`, { name: testName('Renamed'), code: 'R1', color: '#123456' });

      const fetched = (await api.call('GET', `/subjects/${created.id}`)).body.data;
      assert.equal(fetched.name, testName('Renamed'));
      assert.equal(fetched.code, 'R1');
      assert.equal(fetched.color, '#123456');
      const listed = (await api.call('GET', '/subjects')).body.data;
      assert.deepEqual(listed.map((s) => s.name), [testName('Renamed')]);
    });

    test('keeping the same name is allowed; a name used by another subject is not', async () => {
      const first = (await createSubject({ name: testName('History') })).body.data;
      await createSubject({ name: testName('Geography') });

      const same = await api.call('PUT', `/subjects/${first.id}`, { name: testName('History').toLowerCase(), code: 'H1' });
      assert.equal(same.status, 200);

      const clash = await api.call('PUT', `/subjects/${first.id}`, { name: testName('Geography').toUpperCase() });
      assert.equal(clash.status, 409);
      assert.equal((await Subject.findById(first.id)).name, testName('History').toLowerCase());
    });

    test('invalid updates are rejected and leave the stored subject unchanged', async () => {
      const created = (await createSubject({ code: 'KEEP' })).body.data;
      for (const payload of [{ name: '   ' }, {}, { name: MATH, color: 'bad' }, { name: 5 }, { name: MATH, code: 'x'.repeat(30) }]) {
        const { status } = await api.call('PUT', `/subjects/${created.id}`, payload);
        assert.equal(status, 400, `payload ${JSON.stringify(payload)}`);
      }
      const stored = (await api.call('GET', `/subjects/${created.id}`)).body.data;
      assert.deepEqual(stored, created);
    });

    test('editing a subject does not break records that reference it', async () => {
      const created = (await createSubject()).body.data;
      const referenceId = await insertReference('assignments', created.id);

      const { status } = await api.call('PUT', `/subjects/${created.id}`, { name: testName('Renamed Again') });
      assert.equal(status, 200);

      const reference = await mongoose.connection.collection('assignments').findOne({ _id: referenceId });
      assert.equal(reference.subject.toString(), created.id, 'the reference still points at the same subject id');
      assert.equal((await api.call('GET', `/subjects/${created.id}`)).body.data.name, testName('Renamed Again'));
    });
  });

  describe('delete', () => {
    test('deletes an unused subject', async () => {
      const created = (await createSubject()).body.data;
      const { status, body } = await api.call('DELETE', `/subjects/${created.id}`);
      assert.equal(status, 200);
      assert.equal(body.data.id, created.id);
      assert.equal(await countRunSubjects(), 0);
      assert.equal((await api.call('GET', `/subjects/${created.id}`)).status, 404);
    });

    for (const [collection, wording] of [
      ['assignments', /used by 1 assignment\./],
      ['tasks', /used by 1 task\./],
      ['studysessions', /used by 1 study session\./],
    ]) {
      test(`refuses to delete a subject referenced by ${collection} and leaves everything intact`, async () => {
        const created = (await createSubject()).body.data;
        const referenceId = await insertReference(collection, created.id);

        const { status, body } = await api.call('DELETE', `/subjects/${created.id}`);
        assert.equal(status, 409);
        assert.match(body.error.message, wording);

        const stillThere = (await api.call('GET', `/subjects/${created.id}`)).body.data;
        assert.deepEqual(stillThere, created, 'subject unchanged');
        assert.ok(await mongoose.connection.collection(collection).findOne({ _id: referenceId }), 'reference unchanged');
      });
    }

    test('combines every kind of reference in the message and ignores other subjects\' records', async () => {
      const created = (await createSubject()).body.data;
      const other = (await createSubject({ name: testName('Other') })).body.data;
      await insertReference('assignments', created.id);
      await insertReference('assignments', created.id);
      await insertReference('tasks', created.id);
      await insertReference('studysessions', created.id);
      await insertReference('assignments', other.id);

      const { status, body } = await api.call('DELETE', `/subjects/${created.id}`);
      assert.equal(status, 409);
      assert.match(body.error.message, /2 assignments, 1 task and 1 study session/);
      assert.equal(await countRunSubjects(), 2, 'both subjects still exist');
    });

    test('allows deletion once the references are gone', async () => {
      const created = (await createSubject()).body.data;
      await insertReference('tasks', created.id);
      assert.equal((await api.call('DELETE', `/subjects/${created.id}`)).status, 409);

      await mongoose.connection.collection('tasks').deleteMany({ subject: new mongoose.Types.ObjectId(created.id) });
      assert.equal((await api.call('DELETE', `/subjects/${created.id}`)).status, 200);
    });

    test('deleting the same subject twice in parallel gives one 200 and the rest 404, never a 500', async () => {
      const created = (await createSubject()).body.data;
      const results = await Promise.all(Array.from({ length: 5 }, () => api.call('DELETE', `/subjects/${created.id}`)));
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 404, 404, 404, 404]);
      assert.equal(await countRunSubjects(), 0);
    });

    test('updating while another request deletes the subject gives 200 or 404, never a 500', async () => {
      for (let round = 0; round < 5; round += 1) {
        const created = (await createSubject({ name: testName(`Race${round}`) })).body.data;
        const [update, remove] = await Promise.all([
          api.call('PUT', `/subjects/${created.id}`, { name: testName(`Race${round}b`) }),
          api.call('DELETE', `/subjects/${created.id}`),
        ]);
        assert.ok([200, 404].includes(update.status), `update gave ${update.status}`);
        assert.equal(remove.status, 200);
        assert.equal(await Subject.countDocuments({ _id: created.id }), 0);
      }
    });
  });
});
