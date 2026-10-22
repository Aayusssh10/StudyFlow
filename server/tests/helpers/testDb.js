import { config } from '../../src/config/env.js';

const REQUIRED_TEST_DB_NAME = 'studyflow_test';

// Returns the database name at the end of a MongoDB URI, e.g. "studyflow_test".
export function databaseNameFromUri(uri) {
  try {
    return new URL(uri).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

// Safety guard: tests may only touch the database named "studyflow_test".
// Returns the test URI, or null when it is not configured.
// Throws if it points at any other database (so real data can never be wiped).
export function getSafeTestUri(uri = config.mongoTestUri) {
  if (!uri) return null;
  const name = databaseNameFromUri(uri);
  if (name !== REQUIRED_TEST_DB_NAME) {
    throw new Error(
      `MONGODB_TEST_URI must use the database "${REQUIRED_TEST_DB_NAME}" (found "${name || 'none'}"). Refusing to run tests.`,
    );
  }
  return uri;
}
