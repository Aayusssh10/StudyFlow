// Proves that a study session can NEVER point at a deleted subject or assignment, whatever order concurrent
// requests run in, and even if the server process dies halfway. Same design as for assignments and tasks
// (src/utils/transaction.js): a session's subject (required) and assignment (optional) are locked inside one
// transaction; a subject with sessions cannot be deleted; deleting an assignment keeps its sessions and clears
// their link. Uses the TEST database only.
import { describe, test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import Assignment from '../src/models/Assignment.js';
import StudySession from '../src/models/StudySession.js';
import Subject from '../src/models/Subject.js';
import Task from '../src/models/Task.js';
import { findDanglingReferences } from '../src/utils/integrity.js';
import { arrived, deferred, isPending, jitter, sleep, timeline, withDeadline } from './helpers/concurrency.js';
import {
  startApiTestServer,
  cleanupRunData,
  countRunSessions,
  findOrphanedAssignments,
  findOrphanedSessions,
  testName,
  testDbAvailable,
} from './helpers/apiTest.js';

const SKIP = testDbAvailable ? false : 'MONGODB_TEST_URI is not set in server/.env';
const here = path.dirname(fileURLToPath(import.meta.url));

describe('reference integrity: study sessions versus subjects and assignments (database: studyflow_test)', { skip: SKIP }, () => {
  let api;
  const collection = (name) => mongoose.connection.collection(name);

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
  beforeEach(cleanupRunData);

  const makeSubject = async (label = 'S') => (await api.call('POST', '/subjects', { name: testName(label) })).body.data;
  const makeAssignment = async (label = 'A') => (await api.call('POST', '/assignments', { title: testName(label), dueDate: '2026-11-01' })).body.data;
  const sessionBody = (subject, fields = {}) => ({ subject: subject.id, date: '2026-10-25', durationMinutes: 30, notes: testName('n'), ...fields });
  const createSession = (subject, fields) => api.call('POST', '/study-sessions', sessionBody(subject, fields));
  const deleteSubject = (id) => api.call('DELETE', `/subjects/${id}`);
  const deleteAssignment = (id) => api.call('DELETE', `/assignments/${id}`);
  const oid = (id) => new mongoose.Types.ObjectId(id);
  const exists = async (name, id) => (await collection(name).countDocuments({ _id: oid(id) })) === 1;
  const storedSession = (id) => collection('studysessions').findOne({ _id: oid(id) });
  const assertConsistent = async () => {
    assert.deepEqual(await findOrphanedSessions(), [], 'no session may point at a missing subject or assignment');
    assert.deepEqual(await findOrphanedAssignments(), []);
    assert.deepEqual(await findDanglingReferences(), []);
  };

  describe('every ordering of "save a session" and "delete its subject" is forced deterministically', () => {
    test('the subject delete has counted 0 sessions, THEN a session is saved: the delete must not remove the subject', async () => {
      const subject = await makeSubject();
      const reached = deferred();
      const release = deferred();
      const sessions = collection('studysessions');
      const original = sessions.countDocuments.bind(sessions);
      let gated = false;
      const stub = mock.method(sessions, 'countDocuments', async (...args) => {
        const count = await original(...args);
        if (args[1]?.session && !gated) {
          gated = true;
          reached.resolve();
          await release.promise; // freeze the delete right after it saw "0 study sessions"
        }
        return count;
      });
      try {
        const deletion = deleteSubject(subject.id);
        await arrived(reached);
        assert.equal((await createSession(subject)).status, 201, 'the session is saved while the delete is frozen');
        release.resolve();
        const deleted = await deletion;
        assert.equal(deleted.status, 409);
        assert.match(deleted.body.error.message, /still used by 1 study session/);
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      assert.equal(await exists('subjects', subject.id), true);
      await assertConsistent();
    });

    test('a session save is in flight (uncommitted) when the subject delete starts: the delete waits, then is refused', async () => {
      const subject = await makeSubject();
      const reached = deferred();
      const release = deferred();
      const original = StudySession.create.bind(StudySession);
      const stub = mock.method(StudySession, 'create', async (...args) => {
        const created = await original(...args);
        reached.resolve();
        await release.promise;
        return created;
      });
      let creation;
      let deletion;
      try {
        creation = createSession(subject);
        await arrived(reached);
        deletion = deleteSubject(subject.id);
        await sleep(500);
        assert.equal(await isPending(deletion), true, 'the delete cannot finish while the save holds the subject');
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      const [created, deleted] = await Promise.all([creation, deletion]);
      assert.equal(created.status, 201);
      assert.equal(deleted.status, 409);
      assert.equal(await exists('subjects', subject.id), true);
      await assertConsistent();
    });

    test('the subject is deleted and committed BEFORE a session locks it: the save is refused and nothing is saved', async () => {
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
        creation = createSession(subject);
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
      assert.equal(await countRunSessions(), 0);
      await assertConsistent();
    });

    test('an UPDATE moves a session onto a subject that is deleted after the update began: refused, session unchanged', async () => {
      const [home, target] = [await makeSubject('Home'), await makeSubject('Target')];
      const session = (await createSession(home)).body.data;
      const before = await storedSession(session.id);

      const reached = deferred();
      const release = deferred();
      const subjects = collection('subjects');
      const original = subjects.updateOne.bind(subjects);
      let gated = false;
      const stub = mock.method(subjects, 'updateOne', async (...args) => {
        if (args[1]?.$inc?.referenceVersion && !gated) {
          gated = true;
          reached.resolve();
          await release.promise; // the update has already read the session (its snapshot exists)
        }
        return original(...args);
      });
      let update;
      try {
        update = api.call('PUT', `/study-sessions/${session.id}`, sessionBody(target, { notes: before.notes }));
        await arrived(reached);
        assert.equal((await deleteSubject(target.id)).status, 200);
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      assert.equal((await update).status, 400);
      assert.deepEqual(await storedSession(session.id), before, 'the session is exactly as before');
      await assertConsistent();
    });

    test('a session that keeps a subject which is somehow missing is refused; moving it to an existing subject repairs it', async () => {
      const [broken, healthy] = [await makeSubject('Broken'), await makeSubject('Healthy')];
      const session = (await createSession(broken)).body.data;
      await collection('subjects').deleteOne({ _id: oid(broken.id) }); // damage done OUTSIDE the app
      const keep = await api.call('PUT', `/study-sessions/${session.id}`, sessionBody(broken, { notes: session.notes }));
      assert.equal(keep.status, 400);
      assert.equal((await api.call('PUT', `/study-sessions/${session.id}`, sessionBody(healthy, { notes: session.notes }))).status, 200);
      await assertConsistent();
    });
  });

  describe('every ordering of "save a session" and "delete its assignment" is forced deterministically', () => {
    test('the assignment is being deleted (sessions un-linked, uncommitted) when a session tries to link it: it waits, then is refused', async () => {
      const [subject, assignment] = [await makeSubject(), await makeAssignment()];
      const reached = deferred();
      const release = deferred();
      const sessions = collection('studysessions');
      const original = sessions.updateMany.bind(sessions);
      const stub = mock.method(sessions, 'updateMany', async (...args) => {
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
        creation = createSession(subject, { assignment: assignment.id });
        await sleep(500);
        assert.equal(await isPending(creation), true, 'the save cannot finish while the delete holds the assignment');
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      const [deleted, created] = await Promise.all([deletion, creation]);
      assert.equal(deleted.status, 200);
      assert.equal(created.status, 400);
      assert.match(created.body.error.message, /assignment does not exist/);
      assert.equal(await countRunSessions(), 0);
      await assertConsistent();
    });

    test('a session link is in flight (uncommitted) when the assignment delete starts: the delete waits, then un-links the new session', async () => {
      const [subject, assignment] = [await makeSubject(), await makeAssignment()];
      const reached = deferred();
      const release = deferred();
      const original = StudySession.create.bind(StudySession);
      const stub = mock.method(StudySession, 'create', async (...args) => {
        const created = await original(...args);
        reached.resolve();
        await release.promise;
        return created;
      });
      let creation;
      let deletion;
      try {
        creation = createSession(subject, { assignment: assignment.id });
        await arrived(reached);
        deletion = deleteAssignment(assignment.id);
        await sleep(500);
        assert.equal(await isPending(deletion), true);
        assert.equal(await exists('assignments', assignment.id), true);
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      const [created, deleted] = await Promise.all([creation, deletion]);
      assert.equal(created.status, 201);
      assert.equal(deleted.status, 200);
      const row = await storedSession(created.body.data.id);
      assert.ok(row, 'the session still exists');
      assert.equal(row.assignment, null, 'the delete saw the new session and cleared its link');
      assert.equal(row.subject.toString(), subject.id, 'its subject (the study time) is intact');
      await assertConsistent();
    });

    test('the assignment is deleted and committed BEFORE a session locks it: the save is refused and nothing is saved', async () => {
      const [subject, assignment] = [await makeSubject(), await makeAssignment()];
      const reached = deferred();
      const release = deferred();
      const assignments = collection('assignments');
      const original = assignments.updateOne.bind(assignments);
      const stub = mock.method(assignments, 'updateOne', async (...args) => {
        if (args[1]?.$inc?.referenceVersion) {
          reached.resolve();
          await release.promise;
        }
        return original(...args);
      });
      let creation;
      try {
        creation = createSession(subject, { assignment: assignment.id });
        await arrived(reached);
        assert.equal((await deleteAssignment(assignment.id)).status, 200);
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      assert.equal((await creation).status, 400);
      assert.equal(await countRunSessions(), 0);
      await assertConsistent();
    });

    test('an UPDATE links a session to an assignment that is deleted after the update began: refused, session unchanged', async () => {
      const [subject, target] = [await makeSubject(), await makeAssignment('Target')];
      const session = (await createSession(subject)).body.data;
      const before = await storedSession(session.id);

      const reached = deferred();
      const release = deferred();
      const assignments = collection('assignments');
      const original = assignments.updateOne.bind(assignments);
      let gated = false;
      const stub = mock.method(assignments, 'updateOne', async (...args) => {
        if (args[1]?.$inc?.referenceVersion && !gated) {
          gated = true;
          reached.resolve();
          await release.promise;
        }
        return original(...args);
      });
      let update;
      try {
        update = api.call('PUT', `/study-sessions/${session.id}`, sessionBody(subject, { assignment: target.id, notes: before.notes }));
        await arrived(reached);
        assert.equal((await deleteAssignment(target.id)).status, 200);
        release.resolve();
      } finally {
        release.resolve();
        stub.mock.restore();
      }
      assert.equal((await update).status, 400);
      assert.deepEqual(await storedSession(session.id), before);
      await assertConsistent();
    });

    test('a session that keeps an assignment which is somehow missing is refused; clearing the link repairs it', async () => {
      const [subject, assignment] = [await makeSubject(), await makeAssignment()];
      const session = (await createSession(subject, { assignment: assignment.id })).body.data;
      await collection('assignments').deleteOne({ _id: oid(assignment.id) }); // damage done OUTSIDE the app
      assert.equal((await api.call('PUT', `/study-sessions/${session.id}`, sessionBody(subject, { assignment: assignment.id, notes: session.notes }))).status, 400);
      assert.equal((await api.call('PUT', `/study-sessions/${session.id}`, sessionBody(subject, { notes: session.notes }))).status, 200);
      await assertConsistent();
    });
  });

  describe('failure recovery: an error halfway through leaves nothing behind', () => {
    test('session save fails after inserting: nothing is saved and the subject and assignment are not left locked or referenced', async () => {
      const [subject, assignment] = [await makeSubject(), await makeAssignment()];
      const original = StudySession.create.bind(StudySession);
      const stub = mock.method(StudySession, 'create', async (...args) => {
        await original(...args);
        throw new Error('simulated database failure');
      });
      let response;
      try {
        response = await createSession(subject, { assignment: assignment.id });
      } finally {
        stub.mock.restore();
      }
      assert.equal(response.status, 500);
      assert.equal(await countRunSessions(), 0, 'rolled back');
      assert.equal((await createSession(subject, { assignment: assignment.id })).status, 201, 'both are still usable');
      assert.equal((await deleteAssignment(assignment.id)).status, 200);
      await assertConsistent();
    });

    test('session update fails after saving: the session keeps its old values and links', async () => {
      const [first, second] = [await makeSubject('First'), await makeSubject('Second')];
      const session = (await createSession(first)).body.data;
      const before = await storedSession(session.id);
      const originalSave = StudySession.prototype.save;
      const stub = mock.method(StudySession.prototype, 'save', async function save(...args) {
        await originalSave.apply(this, args);
        throw new Error('simulated database failure');
      });
      let response;
      try {
        response = await api.call('PUT', `/study-sessions/${session.id}`, sessionBody(second, { durationMinutes: 99, notes: before.notes }));
      } finally {
        stub.mock.restore();
      }
      assert.equal(response.status, 500);
      assert.deepEqual(await storedSession(session.id), before);
      assert.equal((await deleteSubject(second.id)).status, 200, 'the second subject was never referenced');
      await assertConsistent();
    });

    test('assignment delete fails after un-linking its sessions (and tasks): everything rolls back together', async () => {
      const [subject, assignment] = [await makeSubject(), await makeAssignment()];
      const session = (await createSession(subject, { assignment: assignment.id })).body.data;
      const task = (await api.call('POST', '/tasks', { title: testName('T'), date: '2026-10-25', assignment: assignment.id })).body.data;
      const sessionBefore = await storedSession(session.id);
      const taskBefore = await collection('tasks').findOne({ _id: oid(task.id) });

      const sessions = collection('studysessions');
      const original = sessions.updateMany.bind(sessions);
      const stub = mock.method(sessions, 'updateMany', async (...args) => {
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
      assert.deepEqual(await storedSession(session.id), sessionBefore, 'the session was not un-linked');
      assert.deepEqual(await collection('tasks').findOne({ _id: oid(task.id) }), taskBefore, 'and neither was the task');
      assert.equal((await deleteAssignment(assignment.id)).status, 200, 'a normal delete still works');
      assert.equal((await storedSession(session.id)).assignment, null);
      await assertConsistent();
    });
  });

  describe('real concurrency with random timing (every outcome must be consistent)', () => {
    // Random pauses inside the transactions widen every window, as a slow network or database would.
    const slowTransactions = () => {
      const originals = {
        create: StudySession.create.bind(StudySession),
        save: StudySession.prototype.save,
        subjectDelete: Subject.deleteOne.bind(Subject),
        assignmentDelete: Assignment.deleteOne.bind(Assignment),
      };
      const stubs = [
        mock.method(StudySession, 'create', async (...args) => { await jitter(120); return originals.create(...args); }),
        mock.method(StudySession.prototype, 'save', async function save(...args) { await jitter(120); return originals.save.apply(this, args); }),
        mock.method(Subject, 'deleteOne', async (...args) => { await jitter(120); return originals.subjectDelete(...args); }),
        mock.method(Assignment, 'deleteOne', async (...args) => { await jitter(120); return originals.assignmentDelete(...args); }),
      ];
      return () => stubs.forEach((stub) => stub.mock.restore());
    };

    test('session save versus subject delete, 30 rounds: either the session exists and the delete is refused, or the subject is gone and the save is refused', async (t) => {
      t.after(slowTransactions());
      const tally = {};
      for (let round = 0; round < 30; round += 1) {
        const subject = await makeSubject(`Race${round}`);
        const notes = testName(`R${round}`);
        const [created, deleted] = await Promise.all([
          jitter(600).then(() => createSession(subject, { notes })),
          jitter(600).then(() => deleteSubject(subject.id)),
        ]);
        const outcome = `save ${created.status} / delete ${deleted.status}`;
        tally[outcome] = (tally[outcome] ?? 0) + 1;
        assert.ok((created.status === 201 && deleted.status === 409) || (created.status === 400 && deleted.status === 200), `inconsistent outcome: ${outcome}`);
        assert.equal(await exists('subjects', subject.id), deleted.status === 409, outcome);
        assert.equal(await StudySession.countDocuments({ notes }), created.status === 201 ? 1 : 0, outcome);
      }
      await assertConsistent();
      t.diagnostic(`outcomes: ${JSON.stringify(tally)}`);
    });

    test('session save versus assignment delete, 25 rounds: the delete always succeeds; a session that got in ends up un-linked', async (t) => {
      t.after(slowTransactions());
      const subject = await makeSubject('Shared');
      const tally = {};
      for (let round = 0; round < 25; round += 1) {
        const assignment = await makeAssignment(`Race${round}`);
        const notes = testName(`A${round}`);
        const [created, deleted] = await Promise.all([
          jitter(600).then(() => createSession(subject, { notes, assignment: assignment.id })),
          jitter(600).then(() => deleteAssignment(assignment.id)),
        ]);
        const outcome = `save ${created.status} / delete ${deleted.status}`;
        tally[outcome] = (tally[outcome] ?? 0) + 1;
        assert.equal(deleted.status, 200, outcome);
        const row = await collection('studysessions').findOne({ notes });
        if (created.status === 201) assert.equal(row.assignment, null, `the session must be un-linked: ${outcome}`);
        else assert.ok(created.status === 400 && row === null, `inconsistent outcome: ${outcome}`);
      }
      await assertConsistent();
      t.diagnostic(`outcomes: ${JSON.stringify(tally)}`);
    });

    test('moving a session to another subject versus deleting that subject, 20 rounds: the session never points at a deleted subject', async (t) => {
      t.after(slowTransactions());
      const home = await makeSubject('Home');
      const tally = {};
      for (let round = 0; round < 20; round += 1) {
        const target = await makeSubject(`Target${round}`);
        const notes = testName(`M${round}`);
        const session = (await createSession(home, { notes })).body.data;
        const [updated, deleted] = await Promise.all([
          jitter(600).then(() => api.call('PUT', `/study-sessions/${session.id}`, sessionBody(target, { notes }))),
          jitter(600).then(() => deleteSubject(target.id)),
        ]);
        const outcome = `move ${updated.status} / delete ${deleted.status}`;
        tally[outcome] = (tally[outcome] ?? 0) + 1;
        assert.ok((updated.status === 200 && deleted.status === 409) || (updated.status === 400 && deleted.status === 200), `inconsistent outcome: ${outcome}`);
        const row = await storedSession(session.id);
        assert.equal(row.subject.toString(), updated.status === 200 ? target.id : home.id, outcome);
      }
      await assertConsistent();
      t.diagnostic(`outcomes: ${JSON.stringify(tally)}`);
    });

    test('several session saves and one subject delete at once: they all succeed (delete refused) or they all fail (subject deleted)', async (t) => {
      t.after(slowTransactions());
      for (let round = 0; round < 10; round += 1) {
        const subject = await makeSubject(`Many${round}`);
        const results = await Promise.all([
          ...Array.from({ length: 4 }, (_, i) => jitter(600).then(() => createSession(subject, { notes: testName(`N${round}-${i}`) }))),
          jitter(600).then(() => deleteSubject(subject.id)),
        ]);
        const deleted = results.pop();
        const statuses = [...new Set(results.map((r) => r.status))];
        if (deleted.status === 200) assert.deepEqual(statuses, [400]);
        else assert.deepEqual([deleted.status, ...statuses], [409, 201]);
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

    // The database discards an abandoned transaction after about a minute. Until then, requests that touch the same
    // subject or assignment are retried automatically, so recovery is slow but safe. Every wait here has a deadline.
    test('a crash while saving a session or deleting an assignment changes nothing; everything becomes usable again by itself', { timeout: 240000 }, async (t) => {
      const phases = timeline();
      t.after(() => phases.report(t));
      const subject = await makeSubject('Crash');
      const [forSave, forDelete] = [await makeAssignment('CrashSave'), await makeAssignment('CrashDelete')];
      const linked = (await createSession(subject, { notes: testName('linked'), assignment: forDelete.id })).body.data;
      const linkedBefore = await storedSession(linked.id);
      phases.mark('setup done');
      const saving = startCrashServer('crash-in-session-create', 5485);
      const deleting = startCrashServer('crash-in-assignment-unlink-sessions', 5486);
      await withDeadline(Promise.all([saving.ready, deleting.ready]), 60000, 'starting the crash servers');
      phases.mark('crash servers ready');

      const died = await Promise.allSettled([
        fetch(`${saving.url}/study-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sessionBody(subject, { notes: testName('doomed'), assignment: forSave.id })) }),
        fetch(`${deleting.url}/assignments/${forDelete.id}`, { method: 'DELETE' }),
      ]);
      assert.deepEqual(died.map((r) => r.status), ['rejected', 'rejected'], 'both requests died with their server');
      assert.deepEqual(await withDeadline(Promise.all([saving.exited, deleting.exited]), 30000, 'waiting for the crashed servers to exit'), [137, 137]);
      phases.mark('servers killed');

      // Safety, immediately after the crash: nothing from the unfinished transactions is visible.
      assert.equal(await StudySession.countDocuments({ notes: testName('doomed') }), 0, 'the half-saved session was thrown away');
      assert.equal(await exists('assignments', forSave.id), true);
      assert.equal(await exists('assignments', forDelete.id), true, 'the half-done assignment delete was thrown away');
      assert.deepEqual(await storedSession(linked.id), linkedBefore, 'and its session was NOT un-linked');
      await assertConsistent();
      phases.mark('safety checks passed');

      // Recovery: both work normally once the database discards the abandoned transactions.
      const startedAt = Date.now();
      const seconds = () => Math.round((Date.now() - startedAt) / 1000);
      const attempt = async (label, request) => ({ ...(await withDeadline(request, 170000, `${label} after the crash`)), label, seconds: seconds() });
      const [saved, removed] = await Promise.all([
        attempt('session save', createSession(subject, { notes: testName('after crash'), assignment: forSave.id })),
        attempt('assignment delete', deleteAssignment(forDelete.id)),
      ]);
      phases.mark(`recovered (save ${saved.seconds} s, delete ${removed.seconds} s)`);
      const describe = (r) => `${r.label}: HTTP ${r.status} after ${r.seconds} s ${JSON.stringify(r.body)}`;
      assert.equal(saved.status, 201, `the assignment that had a crashed session save can be linked again. ${describe(saved)}`);
      assert.equal(removed.status, 200, `the assignment that had a crashed delete can be deleted again. ${describe(removed)}`);
      assert.equal((await storedSession(linked.id)).assignment, null, 'and its session is un-linked, as it should be');
      t.diagnostic(`both usable again ${seconds()} s after the crash`);
      await assertConsistent();
    });
  });
});
