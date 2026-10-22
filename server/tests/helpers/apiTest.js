import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { createApp } from '../../src/app.js';
import { connectDB, disconnectDB } from '../../src/config/db.js';
import { getSafeTestUri } from './testDb.js';

// Prints a note when a database step is slow (for example blocked behind a killed server's abandoned transaction).
export const slowNote = async (label, work) => {
  const started = Date.now();
  try { return await work(); } finally {
    const seconds = Math.round((Date.now() - started) / 1000);
    if (seconds >= 5) console.log(`# SLOW STEP: ${label} took ${seconds} s`);
  }
};

// True when server/.env has a valid MONGODB_TEST_URI. Used to skip database tests otherwise.
export const testDbAvailable = Boolean(getSafeTestUri());

// Everything a test run creates is tagged with this unique prefix / marker, so cleanup can
// delete exactly those records and nothing else.
const TAG_PATTERN = '^zz_test_[0-9a-f]{8}_';
export const RUN_TAG = `zz_test_${randomBytes(4).toString('hex')}`;
export const testName = (label) => `${RUN_TAG}_${label}`;
const runNameFilter = { name: { $regex: `^${RUN_TAG}_`, $options: 'i' } };
const runTitleFilter = { title: { $regex: `^${RUN_TAG}_`, $options: 'i' } }; // assignments and tasks made through the API

// Study sessions have no title, so test sessions are recognised by their NOTES, which always start with the run tag.
const runNotesFilter = { notes: { $regex: `^${RUN_TAG}_`, $options: 'i' } };

// Collections that will later hold records pointing at a subject.
const DEPENDENT_COLLECTIONS = ['assignments', 'tasks', 'studysessions'];

function assertTestDatabase() {
  if (mongoose.connection.name !== 'studyflow_test') {
    throw new Error(`Refusing to touch database "${mongoose.connection.name}": tests may only use "studyflow_test".`);
  }
}

// Inserts a stand-in record (assignment/task/session) that references a subject.
// It carries the run marker so cleanup can find it.
export async function insertReference(collection, subjectId) {
  assertTestDatabase();
  const id = new mongoose.Types.ObjectId(subjectId);
  const result = await mongoose.connection.collection(collection).insertOne({ subject: id, testRun: RUN_TAG });
  return result.insertedId;
}

// Connects to the TEST database and starts the API on a random free port.
export async function startApiTestServer() {
  await slowNote('connect to the test database', () => connectDB(getSafeTestUri()));
  assertTestDatabase();

  // Remove leftovers of CRASHED earlier test runs (recognised by their tag), then refuse to
  // continue if anything else is in these collections: it might be someone's real data.
  const db = mongoose.connection;
  await slowNote('start-up cleanup of leftovers', async () => {
    await db.collection('subjects').deleteMany({ name: { $regex: TAG_PATTERN, $options: 'i' } });
    await db.collection('assignments').deleteMany({ title: { $regex: TAG_PATTERN, $options: 'i' } });
    await db.collection('tasks').deleteMany({ title: { $regex: TAG_PATTERN, $options: 'i' } });
    await db.collection('studysessions').deleteMany({ notes: { $regex: TAG_PATTERN, $options: 'i' } });
    for (const name of DEPENDENT_COLLECTIONS) {
      await db.collection(name).deleteMany({ testRun: { $exists: true } });
    }
    for (const name of ['subjects', ...DEPENDENT_COLLECTIONS]) {
      const count = await db.collection(name).countDocuments({});
      if (count > 0) {
        await disconnectDB();
        throw new Error(`studyflow_test.${name} contains ${count} document(s) not created by tests. Refusing to run.`);
      }
    }
  });

  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Sends a request and returns { status, body }.
  async function call(method, path, body) {
    const response = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await disconnectDB();
  }

  return { call, close, baseUrl };
}

// Deletes ONLY the records created by this test run (by name prefix / marker).
export function cleanupRunData() {
  return slowNote('cleanup of this run\'s test data', cleanupNow);
}

async function cleanupNow() {
  assertTestDatabase();
  await mongoose.connection.collection('subjects').deleteMany(runNameFilter);
  await mongoose.connection.collection('tasks').deleteMany(runTitleFilter);
  await mongoose.connection.collection('studysessions').deleteMany(runNotesFilter);
  await mongoose.connection.collection('assignments').deleteMany(runTitleFilter);
  for (const name of DEPENDENT_COLLECTIONS) {
    await mongoose.connection.collection(name).deleteMany({ testRun: RUN_TAG });
  }
}

export const countRunSubjects = () => mongoose.connection.collection('subjects').countDocuments(runNameFilter);
export const countRunTasks = () => mongoose.connection.collection('tasks').countDocuments(runTitleFilter);
export const countRunSessions = () => mongoose.connection.collection('studysessions').countDocuments(runNotesFilter);
export const countRunAssignments = () => mongoose.connection.collection('assignments').countDocuments(runTitleFilter);

// Assignments of this run whose subject no longer exists ("orphans"). Must always be 0.
export async function findOrphanedAssignments() {
  const db = mongoose.connection;
  const assignments = await db.collection('assignments').find({ ...runTitleFilter, subject: { $ne: null } }).toArray();
  const orphans = [];
  for (const assignment of assignments) {
    if ((await db.collection('subjects').countDocuments({ _id: assignment.subject })) === 0) orphans.push(assignment);
  }
  return orphans;
}

// Tasks of this run whose subject or assignment no longer exists. Must always be 0.
export async function findOrphanedTasks() {
  const db = mongoose.connection;
  const tasks = await db.collection('tasks').find(runTitleFilter).toArray();
  const orphans = [];
  for (const task of tasks) {
    const subjectGone = task.subject && (await db.collection('subjects').countDocuments({ _id: task.subject })) === 0;
    const assignmentGone = task.assignment && (await db.collection('assignments').countDocuments({ _id: task.assignment })) === 0;
    if (subjectGone || assignmentGone) orphans.push(task);
  }
  return orphans;
}

// Study sessions of this run whose subject or assignment no longer exists. Must always be 0.
export async function findOrphanedSessions() {
  const db = mongoose.connection;
  const sessions = await db.collection('studysessions').find(runNotesFilter).toArray();
  const orphans = [];
  for (const session of sessions) {
    const subjectGone = (await db.collection('subjects').countDocuments({ _id: session.subject })) === 0;
    const assignmentGone = session.assignment && (await db.collection('assignments').countDocuments({ _id: session.assignment })) === 0;
    if (subjectGone || assignmentGone) orphans.push(session);
  }
  return orphans;
}
