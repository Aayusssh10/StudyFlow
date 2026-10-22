// Runs the real StudyFlow API against the TEST database in a child process and makes it DIE
// (process.exit, like kill -9: no cleanup code runs) at a chosen point inside a database transaction.
// Used by referenceIntegrity.test.js. Environment: PORT, SCENARIO.
import mongoose from 'mongoose';
import Assignment from '../../src/models/Assignment.js';
import Subject from '../../src/models/Subject.js';
import StudySession from '../../src/models/StudySession.js';
import Task from '../../src/models/Task.js';
import { createApp } from '../../src/app.js';
import { connectDB } from '../../src/config/db.js';
import { getSafeTestUri } from './testDb.js';

await connectDB(getSafeTestUri());
if (mongoose.connection.name !== 'studyflow_test') {
  console.error('Refusing to run: not the test database.');
  process.exit(2);
}

const crash = () => process.exit(137);

if (process.env.SCENARIO === 'crash-in-create') {
  // The assignment is inserted and the subject is locked, but the transaction is never committed.
  const original = Assignment.create.bind(Assignment);
  Assignment.create = async (...args) => {
    await original(...args);
    crash();
  };
}

if (process.env.SCENARIO === 'crash-in-delete') {
  // The subject is deleted inside the transaction, but the transaction is never committed.
  const original = Subject.deleteOne.bind(Subject);
  Subject.deleteOne = async (...args) => {
    await original(...args);
    crash();
  };
}

if (process.env.SCENARIO === 'crash-in-task-create') {
  // The task is inserted and its subject/assignment is locked, but the transaction is never committed.
  const original = Task.create.bind(Task);
  Task.create = async (...args) => {
    await original(...args);
    crash();
  };
}

if (process.env.SCENARIO === 'crash-in-assignment-unlink') {
  // The assignment is deleted and its tasks are un-linked inside the transaction, but it is never committed.
  const tasks = mongoose.connection.collection('tasks');
  const original = tasks.updateMany.bind(tasks);
  tasks.updateMany = async (...args) => {
    await original(...args);
    crash();
  };
}

if (process.env.SCENARIO === 'crash-in-session-create') {
  // The study session is inserted and its subject/assignment are locked, but the transaction is never committed.
  const original = StudySession.create.bind(StudySession);
  StudySession.create = async (...args) => {
    await original(...args);
    crash();
  };
}

if (process.env.SCENARIO === 'crash-in-assignment-unlink-sessions') {
  // The assignment is deleted and its study sessions are un-linked inside the transaction, but it is never committed.
  const sessions = mongoose.connection.collection('studysessions');
  const original = sessions.updateMany.bind(sessions);
  sessions.updateMany = async (...args) => {
    await original(...args);
    crash();
  };
}

createApp().listen(Number(process.env.PORT), () => console.log('READY'));
