// Starts the StudyFlow API for the browser tests, connected ONLY to the test database.
// Port comes from E2E_API_PORT (default 5001). Refuses to start on any other database.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER_DIR, mongoose } from './testDb.mjs';

const load = (relative) => import(pathToFileURL(path.join(SERVER_DIR, relative)).href);
const { config } = await load('src/config/env.js');
const { connectDB } = await load('src/config/db.js');
const { createApp } = await load('src/app.js');

await connectDB(config.mongoTestUri);
if (mongoose.connection.name !== 'studyflow_test') {
  console.error('Refusing to start: not connected to studyflow_test.');
  process.exit(1);
}
const port = Number(process.env.E2E_API_PORT) || 5001;
createApp().listen(port, () => console.log(`READY test API on :${port}, database=studyflow_test`));
