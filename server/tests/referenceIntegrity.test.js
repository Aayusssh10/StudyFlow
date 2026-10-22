// Proves that an assignment can NEVER point at a deleted subject, whatever order concurrent requests
// run in, and even if the server process dies halfway. See src/utils/transaction.js for the design.
// Uses the TEST database only.
import { describe, test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import Assignment from '../src/models/Assignment.js';
import Subject from '../src/models/Subject.js';
import { findDanglingReferences } from '../src/utils/integrity.js';
import { arrived, deferred, isPending, jitter, sleep } from './helpers/concurrency.js';
import {
  startApiTestServer,
  cleanupRunData,
  countRunAssignments,
  findOrphanedAssignments,
  testName,
  testDbAvailable,
  RUN_TAG,
} from './helpers/apiTest.js';

const SKIP = testDbAvailable ? false : 'MONGODB_TEST_URI is not set in server/.env';
const NOW = '2026-10-21T14:30';
const here = path.dirname(fileURLToPath(import.meta.url));

describe('reference integrity: assignments versus subjects (database: studyflow_test)', { skip: SKIP }, () => {
  let api;
  const subjectsCollection = () => mongoose.connection.collection('subjects');
  const assignmentsCollection = () => mongoose.connection.collection('assignments');

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

  const makeSubject = async (label = 'S') => (await api.call('POST', '/subjects', { name: testName(label) })).body.data;
  const body = (fields = {}) => ({ title: testName('A'), dueDate: '2026-10-25', ...fields });
  const createAssignment = (fields) => api.call('POST', `/assignments?now=${NOW}`, body(fields));
  const deleteSubject = (id) => api.call('DELETE', `/subjects/${id}`);
  const subjectExists = async (id) => (await subjectsCollection().countDocuments({ _id: new mongoose.Types.ObjectId(id) })) === 1;
  const storedAssignment = (id) => assignmentsCollection().findOne({ _id: new mongoose.Types.ObjectId(id) });
  const assertConsistent = async () => assert.deepEqual(await findOrphanedAssignments(), [], 'no assignment may point at a missing subject');

  describe('every ordering of "create" and "delete" is forced deterministically', () => {
    test('delete has counted 0 references, THEN a create commits: the delete must not remove the subject', async () => {
      const subject = await makeSubject();
      const reached = deferred();
      const release = deferred();
      const original = assignmentsCollection().countDocuments.bind(assignmentsCollection());
      let gated = false;
      const stub = mock.method(assignmentsCollection(), 'countDocuments', async (...args) => {
        const count = await original(...args);
        if (args[1]?.session && !gated) { // the delete's usage check, inside its transaction
          gated = true;
          reached.resolve();
          await release.promise; // freeze the delete right after it saw "0 references"
        }
        return count;
      });

      try {
        const deletion = deleteSubject(subject.id);
        await arrived(reached);
        const creation = await createAssignment({ subject: subject.id });
        assert.equal(creation.status, 201, 'the create runs to completion while the delete is frozen');
        release.resolve();
        const deleted = await deletion;

        assert.equal(deleted.status, 409, 'the database stops the stale delete; the retry sees the new assignment');
        assert.match(deleted.body.error.message, /still used by 1 assignment/);
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      assert.equal(await subjectExists(subject.id), true);
      assert.equal(await countRunAssignments(), 1);
      await assertConsistent();
    });

    test('a create is in flight and uncommitted when a delete starts: the delete waits, then is refused', async () => {
      const subject = await makeSubject();
      const reached = deferred();
      const release = deferred();
      const original = Assignment.create.bind(Assignment);
      const stub = mock.method(Assignment, 'create', async (...args) => {
        const created = await original(...args);
        reached.resolve();
        await release.promise; // inserted and subject locked, but NOT yet committed
        return created;
      });

      let creation;
      let deletion;
      try {
        creation = createAssignment({ subject: subject.id });
        await arrived(reached);
        deletion = deleteSubject(subject.id);
        await sleep(500);
        assert.equal(await isPending(deletion), true, 'the delete cannot finish while the create holds the subject');
        assert.equal(await subjectExists(subject.id), true);
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      const [created, deleted] = await Promise.all([creation, deletion]);
      assert.equal(created.status, 201);
      assert.equal(deleted.status, 409);
      assert.equal(await subjectExists(subject.id), true);
      await assertConsistent();
    });

    test('the subject is deleted and committed BEFORE a create locks it: the create is refused and saves nothing', async () => {
      const subject = await makeSubject();
      const reached = deferred();
      const release = deferred();
      const original = subjectsCollection().updateOne.bind(subjectsCollection());
      const stub = mock.method(subjectsCollection(), 'updateOne', async (...args) => {
        if (args[1]?.$inc?.referenceVersion) { // the create's lock step
          reached.resolve();
          await release.promise;
        }
        return original(...args);
      });

      let creation;
      try {
        creation = createAssignment({ subject: subject.id });
        await arrived(reached);
        assert.equal((await deleteSubject(subject.id)).status, 200, 'the delete wins');
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      const created = await creation;
      assert.equal(created.status, 400);
      assert.match(created.body.error.message, /does not exist/);
      assert.equal(await countRunAssignments(), 0, 'nothing was saved');
      await assertConsistent();
    });

    test('an UPDATE moves an assignment to a subject that is deleted after the update began: refused, assignment unchanged', async () => {
      const target = await makeSubject('Target');
      const assignment = (await createAssignment({ title: testName('Move me') })).body.data;
      const before = await storedAssignment(assignment.id);

      const reached = deferred();
      const release = deferred();
      const original = subjectsCollection().updateOne.bind(subjectsCollection());
      let gated = false;
      const stub = mock.method(subjectsCollection(), 'updateOne', async (...args) => {
        if (args[1]?.$inc?.referenceVersion && !gated) {
          gated = true;
          reached.resolve();
          await release.promise; // the update has already read the assignment (its snapshot exists)
        }
        return original(...args);
      });

      let update;
      try {
        update = api.call('PUT', `/assignments/${assignment.id}`, body({ title: testName('Moved'), subject: target.id }));
        await arrived(reached);
        assert.equal((await deleteSubject(target.id)).status, 200, 'the unused target subject is deleted meanwhile');
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      const updated = await update;
      assert.equal(updated.status, 400, 'the database detects the conflict; the retry finds the subject gone');
      assert.deepEqual(await storedAssignment(assignment.id), before, 'the assignment is exactly as before');
      await assertConsistent();
    });

    test('an update that keeps an existing subject needs no lock, but refuses if that subject is somehow missing', async () => {
      const subject = await makeSubject();
      const assignment = (await createAssignment({ subject: subject.id })).body.data;
      assert.equal((await api.call('PUT', `/assignments/${assignment.id}`, body({ title: testName('Renamed'), subject: subject.id }))).status, 200);

      // Simulate damage done OUTSIDE the app (e.g. someone deleted the subject in Compass).
      await subjectsCollection().deleteOne({ _id: new mongoose.Types.ObjectId(subject.id) });
      const repair = await api.call('PUT', `/assignments/${assignment.id}`, body({ title: testName('Renamed again'), subject: subject.id }));
      assert.equal(repair.status, 400, 'the app will not re-save a reference to a missing subject');
      assert.equal((await api.call('PUT', `/assignments/${assignment.id}`, body({ title: testName('Repaired'), subject: null }))).status, 200, 'clearing the subject repairs it');
      await assertConsistent();
    });
  });

  describe('failure recovery: an error halfway through leaves nothing behind', () => {
    test('create fails after inserting: nothing is saved and the subject is not left locked or referenced', async () => {
      const subject = await makeSubject();
      const original = Assignment.create.bind(Assignment);
      const stub = mock.method(Assignment, 'create', async (...args) => {
        await original(...args);
        throw new Error('simulated database failure');
      });
      let response;
      try {
        response = await createAssignment({ subject: subject.id });
      } finally {
        stub.mock.restore();
      }
      assert.equal(response.status, 500);
      assert.equal(await countRunAssignments(), 0, 'the half-made assignment was rolled back');
      assert.equal((await createAssignment({ subject: subject.id })).status, 201, 'the subject is still usable');
      await assertConsistent();
    });

    test('update fails after saving: the assignment keeps its old values and old subject', async () => {
      const [first, second] = [await makeSubject('First'), await makeSubject('Second')];
      const assignment = (await createAssignment({ subject: first.id })).body.data;
      const before = await storedAssignment(assignment.id);
      const originalSave = Assignment.prototype.save;
      const stub = mock.method(Assignment.prototype, 'save', async function save(...args) {
        await originalSave.apply(this, args);
        throw new Error('simulated database failure');
      });
      let response;
      try {
        response = await api.call('PUT', `/assignments/${assignment.id}`, body({ title: testName('Changed'), subject: second.id }));
      } finally {
        stub.mock.restore();
      }
      assert.equal(response.status, 500);
      assert.deepEqual(await storedAssignment(assignment.id), before);
      assert.equal((await deleteSubject(second.id)).status, 200, 'the second subject was never referenced, so it can be deleted');
      await assertConsistent();
    });

    test('subject delete fails after deleting: the subject is still there, untouched', async () => {
      const subject = await makeSubject();
      const stored = await subjectsCollection().findOne({ _id: new mongoose.Types.ObjectId(subject.id) });
      const original = Subject.deleteOne.bind(Subject);
      const stub = mock.method(Subject, 'deleteOne', async (...args) => {
        await original(...args);
        throw new Error('simulated database failure');
      });
      let response;
      try {
        response = await deleteSubject(subject.id);
      } finally {
        stub.mock.restore();
      }
      assert.equal(response.status, 500);
      assert.deepEqual(await subjectsCollection().findOne({ _id: stored._id }), stored);
      assert.equal((await deleteSubject(subject.id)).status, 200, 'and it can be deleted normally afterwards');
    });
  });

  describe('real concurrency with random timing (every outcome pair must be consistent)', () => {
    // Random pauses inside the transactions widen every window, as a slow network or database would.
    const slowTransactions = () => {
      const originalCreate = Assignment.create.bind(Assignment);
      const originalDelete = Subject.deleteOne.bind(Subject);
      const originalSave = Assignment.prototype.save;
      const stubs = [
        mock.method(Assignment, 'create', async (...args) => { await jitter(120); return originalCreate(...args); }),
        mock.method(Subject, 'deleteOne', async (...args) => { await jitter(120); return originalDelete(...args); }),
        mock.method(Assignment.prototype, 'save', async function save(...args) { await jitter(120); return originalSave.apply(this, args); }),
      ];
      return () => stubs.forEach((stub) => stub.mock.restore());
    };

    test('create versus delete, 40 rounds: either the assignment exists and the delete is refused, or the subject is gone and the create is refused', async (t) => {
      t.after(slowTransactions());
      const tally = {};
      for (let round = 0; round < 40; round += 1) {
        const subject = await makeSubject(`Race${round}`);
        const [created, deleted] = await Promise.all([
          jitter(600).then(() => createAssignment({ title: testName(`R${round}`), subject: subject.id })),
          jitter(600).then(() => deleteSubject(subject.id)),
        ]);
        const outcome = `create ${created.status} / delete ${deleted.status}`;
        tally[outcome] = (tally[outcome] ?? 0) + 1;

        const pairIsValid = (created.status === 201 && deleted.status === 409) || (created.status === 400 && deleted.status === 200);
        assert.ok(pairIsValid, `inconsistent outcome: ${outcome}`);
        assert.equal(await subjectExists(subject.id), deleted.status === 409, outcome);
        assert.equal(await Assignment.countDocuments({ title: testName(`R${round}`) }), created.status === 201 ? 1 : 0, outcome);
      }
      await assertConsistent();
      t.diagnostic(`outcomes: ${JSON.stringify(tally)}`);
    });

    test('update versus delete, 30 rounds: the assignment ends up on the subject only if the delete was refused', async (t) => {
      t.after(slowTransactions());
      const tally = {};
      for (let round = 0; round < 30; round += 1) {
        const subject = await makeSubject(`Move${round}`);
        const assignment = (await createAssignment({ title: testName(`M${round}`) })).body.data;
        const [updated, deleted] = await Promise.all([
          jitter(600).then(() => api.call('PUT', `/assignments/${assignment.id}`, body({ title: testName(`M${round}`), subject: subject.id }))),
          jitter(600).then(() => deleteSubject(subject.id)),
        ]);
        const outcome = `update ${updated.status} / delete ${deleted.status}`;
        tally[outcome] = (tally[outcome] ?? 0) + 1;

        assert.ok((updated.status === 200 && deleted.status === 409) || (updated.status === 400 && deleted.status === 200), `inconsistent outcome: ${outcome}`);
        const stored = await storedAssignment(assignment.id);
        if (updated.status === 200) assert.equal(stored.subject.toString(), subject.id, outcome);
        else assert.equal(stored.subject, null, outcome);
      }
      await assertConsistent();
      t.diagnostic(`outcomes: ${JSON.stringify(tally)}`);
    });

    test('several creates and one delete at once: they all succeed (delete refused) or they all fail (subject deleted)', async (t) => {
      t.after(slowTransactions());
      const tally = {};
      for (let round = 0; round < 12; round += 1) {
        const subject = await makeSubject(`Many${round}`);
        const results = await Promise.all([
          ...Array.from({ length: 4 }, (_, i) => jitter(600).then(() => createAssignment({ title: testName(`N${round}-${i}`), subject: subject.id }))),
          jitter(600).then(() => deleteSubject(subject.id)),
        ]);
        const deleted = results.pop();
        const createStatuses = [...new Set(results.map((r) => r.status))];
        const outcome = `delete ${deleted.status}, creates ${createStatuses.join('/')}`;
        tally[outcome] = (tally[outcome] ?? 0) + 1;

        if (deleted.status === 200) assert.deepEqual(createStatuses, [400], outcome);
        else assert.deepEqual([deleted.status, ...createStatuses], [409, 201], outcome);
      }
      await assertConsistent();
      t.diagnostic(`outcomes: ${JSON.stringify(tally)}`);
    });
  });

  describe('a real process crash in the middle of a transaction (the process is killed)', () => {
    function startCrashServer(scenario, port) {
      const child = spawn(process.execPath, [path.join(here, 'helpers', 'crashServer.mjs')], {
        env: { ...process.env, PORT: String(port), SCENARIO: scenario },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      child.stdout.on('data', (chunk) => { log += chunk; });
      child.stderr.on('data', (chunk) => { log += chunk; });
      const exited = new Promise((resolve) => child.on('exit', resolve));
      const ready = (async () => {
        for (let i = 0; i < 80 && !log.includes('READY'); i += 1) await sleep(250);
        if (!log.includes('READY')) throw new Error(`crash server did not start: ${log}`);
      })();
      return { child, ready, exited, url: `http://127.0.0.1:${port}/api` };
    }

    // The database discards an abandoned transaction after about a minute (its default lifetime limit).
    // Until then, other requests that touch the same subject are retried automatically, so recovery is slow
    // but safe. This test waits for that recovery.
    test('a crash while creating or deleting changes nothing; the subjects become usable again by themselves', { timeout: 200000 }, async (t) => {
      const [forCreate, forDelete] = [await makeSubject('CrashCreate'), await makeSubject('CrashDelete')];
      const creating = startCrashServer('crash-in-create', 5481);
      const deleting = startCrashServer('crash-in-delete', 5482);
      await Promise.all([creating.ready, deleting.ready]);

      const died = await Promise.allSettled([
        fetch(`${creating.url}/assignments?now=${NOW}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body({ title: testName('Doomed'), subject: forCreate.id })) }),
        fetch(`${deleting.url}/subjects/${forDelete.id}`, { method: 'DELETE' }),
      ]);
      assert.deepEqual(died.map((r) => r.status), ['rejected', 'rejected'], 'both requests died with their server');
      assert.deepEqual(await Promise.all([creating.exited, deleting.exited]), [137, 137], 'both servers were killed mid-transaction');

      // Safety, immediately after the crash: nothing from the unfinished transactions is visible.
      assert.equal(await subjectExists(forCreate.id), true);
      assert.equal(await subjectExists(forDelete.id), true, 'the half-done delete was thrown away');
      assert.equal(await countRunAssignments(), 0, 'the half-done create was thrown away');
      await assertConsistent();
      assert.deepEqual(await findDanglingReferences(), []);

      // Recovery: both subjects work normally once the database discards the abandoned transactions.
      const startedAt = Date.now();
      const [created, deleted] = await Promise.all([
        createAssignment({ title: testName('After crash'), subject: forCreate.id }),
        deleteSubject(forDelete.id),
      ]);
      assert.equal(created.status, 201, 'the subject that had a crashed create can be used again');
      assert.equal(deleted.status, 200, 'the subject that had a crashed delete can be deleted again');
      t.diagnostic(`both subjects usable again ${Math.round((Date.now() - startedAt) / 1000)} s after the crash`);
      await assertConsistent();
    });
  });

  describe('the read-only integrity checker', () => {
    test('finds records that point at a missing subject (damage made outside the app) and nothing else', async () => {
      const subject = await makeSubject();
      await createAssignment({ subject: subject.id });
      assert.deepEqual(await findDanglingReferences(), []);

      const missingSubject = new mongoose.Types.ObjectId();
      const { insertedId } = await assignmentsCollection().insertOne({ title: testName('Damaged'), subject: missingSubject, testRun: RUN_TAG });
      const found = await findDanglingReferences();
      assert.deepEqual(found, [{ collection: 'assignments', id: insertedId.toString(), field: 'subject', missing: missingSubject.toString() }]);
    });
  });
});
