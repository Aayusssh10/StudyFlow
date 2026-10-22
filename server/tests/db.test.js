import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectDB, disconnectDB, isDbConnected } from '../src/config/db.js';
import { databaseNameFromUri, getSafeTestUri } from './helpers/testDb.js';

test('connectDB rejects clearly when no URI is configured', async () => {
  await assert.rejects(() => connectDB(''), /Database URI is not set/);
  assert.equal(isDbConnected(), false);
});

test('connectDB failure is handled and never leaks the URI or password', async () => {
  // Port 1 is closed, so this must fail quickly.
  const badUri = 'mongodb://fakeuser:SuperSecretPw123@127.0.0.1:1/studyflow_test';
  await assert.rejects(
    () => connectDB(badUri, { timeoutMs: 1500 }),
    (error) => {
      assert.match(error.message, /Could not connect to MongoDB/);
      assert.doesNotMatch(error.message, /SuperSecretPw123|fakeuser|127\.0\.0\.1/);
      return true;
    },
  );
  assert.equal(isDbConnected(), false);
});

test('databaseNameFromUri reads the database name', () => {
  assert.equal(databaseNameFromUri('mongodb+srv://u:p@host.example/studyflow_test?x=1'), 'studyflow_test');
  assert.equal(databaseNameFromUri('not a uri'), '');
});

test('test guard refuses any database other than studyflow_test', () => {
  assert.throws(() => getSafeTestUri('mongodb://h/studyflow'), /must use the database "studyflow_test"/);
  assert.throws(() => getSafeTestUri('mongodb://h/'), /must use the database "studyflow_test"/);
  assert.equal(getSafeTestUri('mongodb://h/studyflow_test'), 'mongodb://h/studyflow_test');
  assert.equal(getSafeTestUri(''), null);
});

test(
  'REAL connection to the Atlas test database succeeds and can be pinged',
  { skip: getSafeTestUri() ? false : 'MONGODB_TEST_URI is not set in server/.env' },
  async () => {
    try {
      await connectDB(getSafeTestUri());
      assert.equal(isDbConnected(), true);
      assert.equal(mongoose.connection.name, 'studyflow_test');
      const ping = await mongoose.connection.db.admin().ping();
      assert.equal(ping.ok, 1);
    } finally {
      await disconnectDB();
    }
  },
);
