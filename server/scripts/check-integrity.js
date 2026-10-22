// Read-only health check for the database. Never changes data.
//
//   npm run check:integrity             checks the database in MONGODB_URI (your real data)
//   npm run check:integrity -- --test   checks the test database in MONGODB_TEST_URI
//
// Exit code 0 = no problems found, 1 = problems found (listed), 2 = could not run.
import { config } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { findDanglingReferences } from '../src/utils/integrity.js';

const useTestDatabase = process.argv.includes('--test');

try {
  await connectDB(useTestDatabase ? config.mongoTestUri : config.mongoUri);
  const dangling = await findDanglingReferences();

  if (dangling.length === 0) {
    console.log('OK: no record points at a subject or assignment that does not exist.');
  } else {
    console.log(`PROBLEM: ${dangling.length} record(s) point at something that does not exist:`);
    for (const item of dangling) console.log(`  ${item.collection} ${item.id}: ${item.field} -> missing ${item.missing}`);
    console.log('Fix each one by editing it in the app (choose an existing target or clear the link), or delete it.');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Could not check: ${error.message}`);
  process.exitCode = 2;
} finally {
  await disconnectDB();
}
