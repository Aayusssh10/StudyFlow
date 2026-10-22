// Database access for the browser tests. It can ONLY ever talk to the database named "studyflow_test",
// and it only deletes records that carry this run's tag.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER_DIR = path.join(ROOT, 'server');
export const CLIENT_DIR = path.join(ROOT, 'client');

// Resolve mongoose / dotenv from the server's own node_modules (no duplicate install).
const requireFromServer = createRequire(pathToFileURL(path.join(SERVER_DIR, 'package.json')));
export const mongoose = requireFromServer('mongoose');
requireFromServer('dotenv').config({ path: path.join(SERVER_DIR, '.env'), quiet: true });

const COLLECTIONS = ['subjects', 'assignments', 'tasks', 'studysessions'];
const STALE_PATTERN = '^zz_test_[0-9a-f]{8}_';

export const tag = `zz_test_${randomBytes(4).toString('hex')}`;
export const N = (label) => `${tag}_${label}`;

export async function connectTestDb() {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) throw new Error('MONGODB_TEST_URI is not set in server/.env. The browser tests need the test database.');
  const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 8000 }).asPromise();
  if (connection.name !== 'studyflow_test') {
    await connection.close();
    throw new Error(`MONGODB_TEST_URI must use the database "studyflow_test" (found "${connection.name}"). Refusing to run.`);
  }
  const col = (name) => connection.db.collection(name);

  const counts = async () => Object.fromEntries(await Promise.all(COLLECTIONS.map(async (name) => [name, await col(name).countDocuments({})])));

  // Removes only records created by this run (by name/title prefix or marker).
  async function cleanup() {
    const subjects = (await col('subjects').deleteMany({ name: { $regex: `^${tag}_`, $options: 'i' } })).deletedCount;
    const assignments = (await col('assignments').deleteMany({ title: { $regex: `^${tag}_`, $options: 'i' } })).deletedCount;
    const tasks = (await col('tasks').deleteMany({ title: { $regex: `^${tag}_`, $options: 'i' } })).deletedCount;
    // Study sessions have no title: test sessions are recognised by their NOTES, which always start with the tag.
    const sessions = (await col('studysessions').deleteMany({ notes: { $regex: `^${tag}_`, $options: 'i' } })).deletedCount;
    return { subjects, assignments, tasks, sessions };
  }

  // Start of run: clear leftovers of earlier CRASHED runs (recognised by their tag), then refuse if
  // anything else is in the collections: it might be someone's real data.
  async function prepare() {
    await col('subjects').deleteMany({ name: { $regex: STALE_PATTERN, $options: 'i' } });
    await col('assignments').deleteMany({ title: { $regex: STALE_PATTERN, $options: 'i' } });
    await col('tasks').deleteMany({ title: { $regex: STALE_PATTERN, $options: 'i' } });
    await col('studysessions').deleteMany({ notes: { $regex: STALE_PATTERN, $options: 'i' } });
    const found = await counts();
    if (Object.values(found).some((count) => count > 0)) {
      throw new Error(`studyflow_test contains data not created by tests: ${JSON.stringify(found)}. Refusing to run.`);
    }
  }

  return { connection, col, counts, cleanup, prepare, close: () => connection.close() };
}
