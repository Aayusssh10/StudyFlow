// Proves that a task can NEVER point at a deleted subject or assignment, whatever order concurrent requests
// run in, and even if the server process dies halfway. Same design as for assignments: see
// src/utils/transaction.js. Deleting an assignment keeps its tasks and clears their link; deleting a subject
// that tasks use is refused. Uses the TEST database only.
import { describe, test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import Assignment from '../src/models/Assignment.js';
import Subject from '../src/models/Subject.js';
import Task from '../src/models/Task.js';
import { findDanglingReferences } from '../src/utils/integrity.js';
import { arrived, deferred, isPending, jitter, sleep, timeline, withDeadline } from './helpers/concurrency.js';
import {
  startApiTestServer,
  cleanupRunData,
  countRunTasks,
  findOrphanedAssignments,
  findOrphanedTasks,
  testName,
  testDbAvailable,
} from './helpers/apiTest.js';

const SKIP = testDbAvailable ? false : 'MONGODB_TEST_URI is not set in server/.env';
const NOW = '2026-10-21T14:30';
const here = path.dirname(fileURLToPath(import.meta.url));

describe('reference integrity: tasks versus subjects and assignments (database: studyflow_test)', { skip: SKIP }, () => {
  let api;
  const collection = (name) => mongoose.connection.collection(name);

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

  const makeSubject = async (label = 'S') => (await api.call('POST', '/subjects', { name: testName(label) })).body.data;
  const makeAssignment = async (label = 'A') => (await api.call('POST', '/assignments', { title: testName(label), dueDate: '2026-11-01' })).body.data;
  const taskBody = (fields = {}) => ({ title: testName('T'), date: '2026-10-25', ...fields });
  const createTask = (fields) => api.call('POST', `/tasks?now=${NOW}`, taskBody(fields));
  const deleteSubject = (id) => api.call('DELETE', `/subjects/${id}`);
  const deleteAssignment = (id) => api.call('DELETE', `/assignments/${id}`);
  const oid = (id) => new mongoose.Types.ObjectId(id);
  const exists = async (name, id) => (await collection(name).countDocuments({ _id: oid(id) })) === 1;
  const storedTask = (id) => collection('tasks').findOne({ _id: oid(id) });
  const assertConsistent = async () => {
    assert.deepEqual(await findOrphanedTasks(), [], 'no task may point at a missing subject or assignment');
    assert.deepEqual(await findOrphanedAssignments(), []);
    assert.deepEqual(await findDanglingReferences(), []);
  };

  describe('every ordering of "create a task" and "delete its assignment" is forced deterministically', () => {
    test('the assignment is being deleted (unlinked, uncommitted) when a task tries to link it: the task waits, then is refused', async () => {
      const assignment = await makeAssignment();
      const reached = deferred();
      const release = deferred();
      const tasks = collection('tasks');
      const original = tasks.updateMany.bind(tasks);
      const stub = mock.method(tasks, 'updateMany', async (...args) => {
        const result = await original(...args);
        reached.resolve();
        await release.promise; // the delete has deleted the assignment and cleared its links, but not committed
        return result;
      });

      let deletion;
      let creation;
      try {
        deletion = deleteAssignment(assignment.id);
        await arrived(reached);
        creation = createTask({ assignment: assignment.id });
        await sleep(500);
        assert.equal(await isPending(creation), true, 'the create cannot finish while the delete holds the assignment');
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      const [deleted, created] = await Promise.all([deletion, creation]);
      assert.equal(deleted.status, 200);
      assert.equal(created.status, 400, 'after the delete commits, the retry finds the assignment gone');
      assert.match(created.body.error.message, /assignment does not exist/);
      assert.equal(await countRunTasks(), 0, 'nothing was saved');
      await assertConsistent();
    });

    test('a task link is in flight (uncommitted) when the assignment delete starts: the delete waits, then un-links the new task', async () => {
      const assignment = await makeAssignment();
      const reached = deferred();
      const release = deferred();
      const original = Task.create.bind(Task);
      const stub = mock.method(Task, 'create', async (...args) => {
        const created = await original(...args);
        reached.resolve();
        await release.promise; // inserted and assignment locked, but NOT yet committed
        return created;
      });

      let creation;
      let deletion;
      try {
        creation = createTask({ assignment: assignment.id });
        await arrived(reached);
        deletion = deleteAssignment(assignment.id);
        await sleep(500);
        assert.equal(await isPending(deletion), true, 'the delete cannot finish while the create holds the assignment');
        assert.equal(await exists('assignments', assignment.id), true);
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      const [created, deleted] = await Promise.all([creation, deletion]);
      assert.equal(created.status, 201);
      assert.equal(deleted.status, 200);
      const task = await storedTask(created.body.data.id);
      assert.ok(task, 'the task still exists');
      assert.equal(task.assignment, null, 'the delete saw the new task and cleared its link');
      await assertConsistent();
    });

    test('the assignment is deleted and committed BEFORE a task locks it: the task is refused and saves nothing', async () => {
      const assignment = await makeAssignment();
      const reached = deferred();
      const release = deferred();
      const assignments = collection('assignments');
      const original = assignments.updateOne.bind(assignments);
      const stub = mock.method(assignments, 'updateOne', async (...args) => {
        if (args[1]?.$inc?.referenceVersion) { // the task's lock step
          reached.resolve();
          await release.promise;
        }
        return original(...args);
      });

      let creation;
      try {
        creation = createTask({ assignment: assignment.id });
        await arrived(reached);
        assert.equal((await deleteAssignment(assignment.id)).status, 200, 'the delete wins');
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      const created = await creation;
      assert.equal(created.status, 400);
      assert.equal(await countRunTasks(), 0);
      await assertConsistent();
    });

    test('an UPDATE moves a task onto an assignment that is deleted after the update began: refused, task unchanged', async () => {
      const target = await makeAssignment('Target');
      const task = (await createTask({ title: testName('Move me') })).body.data;
      const before = await storedTask(task.id);

      const reached = deferred();
      const release = deferred();
      const assignments = collection('assignments');
      const original = assignments.updateOne.bind(assignments);
      let gated = false;
      const stub = mock.method(assignments, 'updateOne', async (...args) => {
        if (args[1]?.$inc?.referenceVersion && !gated) {
          gated = true;
          reached.resolve();
          await release.promise; // the update has already read the task (its snapshot exists)
        }
        return original(...args);
      });

      let update;
      try {
        update = api.call('PUT', `/tasks/${task.id}`, taskBody({ title: testName('Moved'), assignment: target.id }));
        await arrived(reached);
        assert.equal((await deleteAssignment(target.id)).status, 200);
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      assert.equal((await update).status, 400);
      assert.deepEqual(await storedTask(task.id), before, 'the task is exactly as before');
      await assertConsistent();
    });

    test('an update that keeps an assignment link refuses if that assignment is somehow missing; clearing the link repairs it', async () => {
      const assignment = await makeAssignment();
      const task = (await createTask({ assignment: assignment.id })).body.data;
      await collection('assignments').deleteOne({ _id: oid(assignment.id) }); // damage done OUTSIDE the app
      const keep = await api.call('PUT', `/tasks/${task.id}`, taskBody({ title: testName('Again'), assignment: assignment.id }));
      assert.equal(keep.status, 400);
      assert.equal((await api.call('PUT', `/tasks/${task.id}`, taskBody({ title: testName('Repaired') }))).status, 200);
      await assertConsistent();
    });
  });

  describe('every ordering of "create a task" and "delete its subject" is forced deterministically', () => {
    test('a task create is in flight (uncommitted) when the subject delete starts: the delete waits, then is refused', async () => {
      const subject = await makeSubject();
      const reached = deferred();
      const release = deferred();
      const original = Task.create.bind(Task);
      const stub = mock.method(Task, 'create', async (...args) => {
        const created = await original(...args);
        reached.resolve();
        await release.promise;
        return created;
      });

      let creation;
      let deletion;
      try {
        creation = createTask({ subject: subject.id });
        await arrived(reached);
        deletion = deleteSubject(subject.id);
        await sleep(500);
        assert.equal(await isPending(deletion), true);
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      const [created, deleted] = await Promise.all([creation, deletion]);
      assert.equal(created.status, 201);
      assert.equal(deleted.status, 409);
      assert.match(deleted.body.error.message, /still used by 1 task/);
      assert.equal(await exists('subjects', subject.id), true);
      await assertConsistent();
    });

    test('the subject is deleted and committed BEFORE a task locks it: the task is refused and saves nothing', async () => {
      const subject = await makeSubject();
      const reached = deferred();
      const release = deferred();
      const subjects = collection('subjects');
      const original = subjects.updateOne.bind(subjects);
      const stub = mock.method(subjects, 'updateOne', async (...args) => {
        if (args[1]?.$inc?.referenceVersion) {
          reached.resolve();
          await release.promise;
        }
        return original(...args);
      });

      let creation;
      try {
        creation = createTask({ subject: subject.id });
        await arrived(reached);
        assert.equal((await deleteSubject(subject.id)).status, 200);
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      const created = await creation;
      assert.equal(created.status, 400);
      assert.match(created.body.error.message, /subject does not exist/);
      assert.equal(await countRunTasks(), 0);
      await assertConsistent();
    });
  });

  describe('failure recovery: an error halfway through leaves nothing behind', () => {
    test('task create fails after inserting: nothing is saved and the assignment and subject are not left locked or referenced', async () => {
      const [assignment, subject] = [await makeAssignment(), await makeSubject()];
      const original = Task.create.bind(Task);
      const stub = mock.method(Task, 'create', async (...args) => {
        await original(...args);
        throw new Error('simulated database failure');
      });
      const responses = [];
      try {
        responses.push(await createTask({ assignment: assignment.id }), await createTask({ subject: subject.id }));
      } finally {
        stub.mock.restore();
      }
      assert.deepEqual(responses.map((r) => r.status), [500, 500]);
      assert.equal(await countRunTasks(), 0, 'rolled back');
      assert.equal((await createTask({ assignment: assignment.id })).status, 201, 'the assignment is still usable');
      assert.equal((await deleteAssignment(assignment.id)).status, 200);
      assert.equal((await deleteSubject(subject.id)).status, 200, 'the subject was never referenced, so it can be deleted');
      await assertConsistent();
    });

    test('task update fails after saving: the task keeps its old values and old link', async () => {
      const [first, second] = [await makeAssignment('First'), await makeAssignment('Second')];
      const task = (await createTask({ assignment: first.id })).body.data;
      const before = await storedTask(task.id);
      const originalSave = Task.prototype.save;
      const stub = mock.method(Task.prototype, 'save', async function save(...args) {
        await originalSave.apply(this, args);
        throw new Error('simulated database failure');
      });
      let response;
      try {
        response = await api.call('PUT', `/tasks/${task.id}`, taskBody({ title: testName('Changed'), assignment: second.id }));
      } finally {
        stub.mock.restore();
      }
      assert.equal(response.status, 500);
      assert.deepEqual(await storedTask(task.id), before);
      assert.equal((await deleteAssignment(second.id)).status, 200, 'the second assignment was never referenced');
      await assertConsistent();
    });

    test('assignment delete fails after un-linking its tasks: the assignment still exists and the task is still linked', async () => {
      const assignment = await makeAssignment();
      const task = (await createTask({ assignment: assignment.id })).body.data;
      const before = await storedTask(task.id);
      const tasks = collection('tasks');
      const original = tasks.updateMany.bind(tasks);
      const stub = mock.method(tasks, 'updateMany', async (...args) => {
        await original(...args);
        throw new Error('simulated database failure');
      });
      let response;
      try {
        response = await deleteAssignment(assignment.id);
      } finally {
        stub.mock.restore();
      }
      assert.equal(response.status, 500);
      assert.equal(await exists('assignments', assignment.id), true, 'the delete was rolled back');
      assert.deepEqual(await storedTask(task.id), before, 'the task was not un-linked');
      assert.equal((await deleteAssignment(assignment.id)).status, 200, 'and a normal delete still works');
      assert.equal((await storedTask(task.id)).assignment, null);
      await assertConsistent();
    });
  });

  describe('real concurrency with random timing (every outcome must be consistent)', () => {
    // Random pauses inside the transactions widen every window, as a slow network or database would.
    const slowTransactions = () => {
      const originals = {
        taskCreate: Task.create.bind(Task),
        assignmentDelete: Assignment.deleteOne.bind(Assignment),
        subjectDelete: Subject.deleteOne.bind(Subject),
        taskSave: Task.prototype.save,
      };
      const stubs = [
        mock.method(Task, 'create', async (...args) => { await jitter(120); return originals.taskCreate(...args); }),
        mock.method(Assignment, 'deleteOne', async (...args) => { await jitter(120); return originals.assignmentDelete(...args); }),
        mock.method(Subject, 'deleteOne', async (...args) => { await jitter(120); return originals.subjectDelete(...args); }),
        mock.method(Task.prototype, 'save', async function save(...args) { await jitter(120); return originals.taskSave.apply(this, args); }),
      ];
      return () => stubs.forEach((stub) => stub.mock.restore());
    };

    test('task create versus assignment delete, 30 rounds: the delete always succeeds; a task that got in ends up un-linked', async (t) => {
      t.after(slowTransactions());
      const tally = {};
      for (let round = 0; round < 30; round += 1) {
        const assignment = await makeAssignment(`Race${round}`);
        const title = testName(`R${round}`);
        const [created, deleted] = await Promise.all([
          jitter(600).then(() => createTask({ title, assignment: assignment.id })),
          jitter(600).then(() => deleteAssignment(assignment.id)),
        ]);
        const outcome = `create ${created.status} / delete ${deleted.status}`;
        tally[outcome] = (tally[outcome] ?? 0) + 1;

        assert.equal(deleted.status, 200, outcome);
        assert.equal(await exists('assignments', assignment.id), false, outcome);
        const stored = await collection('tasks').findOne({ title });
        if (created.status === 201) assert.equal(stored.assignment, null, `the task must be un-linked: ${outcome}`);
        else assert.ok(created.status === 400 && stored === null, `inconsistent outcome: ${outcome}`);
      }
      await assertConsistent();
      t.diagnostic(`outcomes: ${JSON.stringify(tally)}`);
    });

    test('task create versus subject delete, 30 rounds: either the task exists and the delete is refused, or the subject is gone and the create is refused', async (t) => {
      t.after(slowTransactions());
      const tally = {};
      for (let round = 0; round < 30; round += 1) {
        const subject = await makeSubject(`Race${round}`);
        const [created, deleted] = await Promise.all([
          jitter(600).then(() => createTask({ title: testName(`S${round}`), subject: subject.id })),
          jitter(600).then(() => deleteSubject(subject.id)),
        ]);
        const outcome = `create ${created.status} / delete ${deleted.status}`;
        tally[outcome] = (tally[outcome] ?? 0) + 1;
        assert.ok((created.status === 201 && deleted.status === 409) || (created.status === 400 && deleted.status === 200), `inconsistent outcome: ${outcome}`);
        assert.equal(await exists('subjects', subject.id), deleted.status === 409, outcome);
        assert.equal(await Task.countDocuments({ title: testName(`S${round}`) }), created.status === 201 ? 1 : 0, outcome);
      }
      await assertConsistent();
      t.diagnostic(`outcomes: ${JSON.stringify(tally)}`);
    });

    test('moving a task onto an assignment versus deleting that assignment, 25 rounds: the task never keeps a link to a deleted assignment', async (t) => {
      t.after(slowTransactions());
      const tally = {};
      for (let round = 0; round < 25; round += 1) {
        const assignment = await makeAssignment(`Move${round}`);
        const task = (await createTask({ title: testName(`M${round}`) })).body.data;
        const [updated, deleted] = await Promise.all([
          jitter(600).then(() => api.call('PUT', `/tasks/${task.id}`, taskBody({ title: testName(`M${round}`), assignment: assignment.id }))),
          jitter(600).then(() => deleteAssignment(assignment.id)),
        ]);
        const outcome = `update ${updated.status} / delete ${deleted.status}`;
        tally[outcome] = (tally[outcome] ?? 0) + 1;
        assert.equal(deleted.status, 200, outcome);
        assert.ok([200, 400].includes(updated.status), outcome);
        assert.equal((await storedTask(task.id)).assignment, null, outcome);
      }
      await assertConsistent();
      t.diagnostic(`outcomes: ${JSON.stringify(tally)}`);
    });

    test('several task creates and one assignment delete at once: no task keeps a link, nothing fails with 500/503', async (t) => {
      t.after(slowTransactions());
      for (let round = 0; round < 10; round += 1) {
        const assignment = await makeAssignment(`Many${round}`);
        const results = await Promise.all([
          ...Array.from({ length: 4 }, (_, i) => jitter(600).then(() => createTask({ title: testName(`N${round}-${i}`), assignment: assignment.id }))),
          jitter(600).then(() => deleteAssignment(assignment.id)),
        ]);
        const deleted = results.pop();
        assert.equal(deleted.status, 200);
        for (const result of results) assert.ok([201, 400].includes(result.status), `unexpected ${result.status}`);
        for (let i = 0; i < 4; i += 1) {
          const stored = await collection('tasks').findOne({ title: testName(`N${round}-${i}`) });
          assert.equal(Boolean(stored), results[i].status === 201);
          if (stored) assert.equal(stored.assignment, null);
        }
      }
      await assertConsistent();
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
      return { ready, exited, url: `http://127.0.0.1:${port}/api` };
    }

    // The database discards an abandoned transaction after about a minute. Until then, requests that touch the
    // same subject or assignment are retried automatically, so recovery is slow but safe.
    test('a crash while creating a task or deleting an assignment changes nothing; everything becomes usable again by itself', { timeout: 240000 }, async (t) => {
      const phases = timeline(); // where does the time go? (printed at the end, also when the test fails)
      t.after(() => phases.report(t));
      const [forCreate, forDelete] = [await makeAssignment('CrashCreate'), await makeAssignment('CrashDelete')];
      phases.mark('setup done');
      const linked = (await createTask({ title: testName('Linked'), assignment: forDelete.id })).body.data;
      const linkedBefore = await storedTask(linked.id);
      const creating = startCrashServer('crash-in-task-create', 5483);
      const deleting = startCrashServer('crash-in-assignment-unlink', 5484);
      await withDeadline(Promise.all([creating.ready, deleting.ready]), 60000, 'starting the crash servers');
      phases.mark('crash servers ready');

      const died = await Promise.allSettled([
        fetch(`${creating.url}/tasks?now=${NOW}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(taskBody({ title: testName('Doomed'), assignment: forCreate.id })) }),
        fetch(`${deleting.url}/assignments/${forDelete.id}`, { method: 'DELETE' }),
      ]);
      assert.deepEqual(died.map((r) => r.status), ['rejected', 'rejected'], 'both requests died with their server');
      assert.deepEqual(await withDeadline(Promise.all([creating.exited, deleting.exited]), 30000, 'waiting for the crashed servers to exit'), [137, 137], 'both servers were killed mid-transaction');
      phases.mark('servers killed');

      // Safety, immediately after the crash: nothing from the unfinished transactions is visible.
      assert.equal(await exists('assignments', forCreate.id), true);
      assert.equal(await Task.countDocuments({ title: testName('Doomed') }), 0, 'the half-made task was thrown away');
      assert.equal(await exists('assignments', forDelete.id), true, 'the half-done assignment delete was thrown away');
      assert.deepEqual(await storedTask(linked.id), linkedBefore, 'and the task was NOT un-linked');
      await assertConsistent();
      phases.mark('safety checks passed');

      // Recovery: both work normally once the database discards the abandoned transactions.
      const startedAt = Date.now();
      const seconds = () => Math.round((Date.now() - startedAt) / 1000);
      // Each request reports how long it took and what the server answered, so a slow recovery is explained, not just failed.
      const attempt = async (label, request) => {
        // A request that has not answered within 170 s is a FAILURE (never a pass).
        const response = await withDeadline(request, 170000, `${label} after the crash`);
        return { ...response, label, seconds: seconds() };
      };
      const [created, deleted] = await Promise.all([
        attempt('task create', createTask({ title: testName('After crash'), assignment: forCreate.id })),
        attempt('assignment delete', deleteAssignment(forDelete.id)),
      ]);
      const describe = (r) => `${r.label}: HTTP ${r.status} after ${r.seconds} s ${JSON.stringify(r.body)}`;
      phases.mark(`recovered (create ${created.seconds} s, delete ${deleted.seconds} s)`);
      assert.equal(created.status, 201, `the assignment that had a crashed task create can be linked again. ${describe(created)}`);
      assert.equal(deleted.status, 200, `the assignment that had a crashed delete can be deleted again. ${describe(deleted)}`);
      assert.equal((await storedTask(linked.id)).assignment, null, 'and its task is un-linked, as it should be');
      t.diagnostic(`both usable again ${seconds()} s after the crash (task create ${created.seconds} s, assignment delete ${deleted.seconds} s)`);
      await assertConsistent();
    });
  });
});
