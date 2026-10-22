import mongoose from 'mongoose';
import { AppError } from './AppError.js';

// --- Keeping records from pointing at a deleted subject -----------------------------------------
// MongoDB has no "foreign keys", so the application has to guarantee this itself. Checking first and
// saving afterwards is NOT safe: another request (or a crash) can slip in between the two steps.
//
// Two rules make it safe, and both are needed:
//
//  1. Every write that creates or changes a reference to a subject, and every subject deletion, runs
//     inside ONE all-or-nothing database transaction. If the server crashes halfway, MongoDB throws
//     the unfinished transaction away; nothing is half-saved.
//
//  2. Those writes all "lock" the SAME document: the subject. Creating a reference increments a
//     counter on the subject (lockSubjectForReference); deleting the subject deletes that document.
//     Two writes to one document cannot both commit if their transactions overlap: MongoDB stops one
//     with a WriteConflict and the transaction helper retries it. The retry sees the new truth
//     ("the subject now has a reference" or "the subject is gone") and answers 409 or 400.
//
// Rule 2 matters: transactions alone are not enough. Without a shared write, "delete saw 0 references"
// and "create saw the subject exists" can both commit (write skew) and leave an orphan. This was
// reproduced on the real Atlas cluster before choosing this design.
//
// Every future feature that points at a subject (tasks, study sessions) must do the same:
// create or update the record inside inTransaction() after calling lockSubjectForReference().

const TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

const RETRY_LIMIT_MS = 100_000; // long enough to outlast a crashed request's abandoned transaction (about 65 s)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits a little longer after each failed attempt, with randomness so competing requests do not collide
// again in lockstep. (The driver's built-in retry loop retries instantly, which starves waiting requests.)
const backoff = (attempt) => sleep(Math.min(500, 20 * 2 ** attempt) * (0.5 + Math.random()));

const hasLabel = (error, label) => Boolean(error?.hasErrorLabel?.(label) || error?.errorLabels?.includes?.(label));

// Commits, retrying only when MongoDB says it cannot tell whether the commit happened (safe to ask again).
async function commit(session, deadline) {
  for (;;) {
    try {
      return await session.commitTransaction();
    } catch (error) {
      if (!hasLabel(error, 'UnknownTransactionCommitResult') || Date.now() > deadline) throw error;
    }
  }
}

// Runs work(session) as a single all-or-nothing transaction.
//  - Everything `work` writes is committed together, or none of it is (also if the server dies halfway).
//  - If MongoDB reports a conflict with another request (a TransientTransactionError such as WriteConflict),
//    the whole of `work` runs again after a short pause, so it re-reads the latest data.
//  - Anything else `work` throws (for example an AppError) cancels the transaction and is rethrown as is.
// `work` may therefore run more than once: it must only touch the database through `session`.
export async function inTransaction(work) {
  const session = await mongoose.connection.startSession();
  const deadline = Date.now() + RETRY_LIMIT_MS;

  try {
    for (let attempt = 0; ; attempt += 1) {
      session.startTransaction(TRANSACTION_OPTIONS);
      try {
        const result = await work(session);
        await commit(session, deadline);
        return result;
      } catch (error) {
        if (session.inTransaction()) await session.abortTransaction().catch(() => {});
        if (!hasLabel(error, 'TransientTransactionError') || Date.now() > deadline) throw error;
        await backoff(attempt);
      }
    }
  } finally {
    await session.endSession();
  }
}

export function subjectMissingError() {
  return new AppError('The selected subject does not exist.', 400, [
    { field: 'subject', message: 'Choose a subject that exists, or leave it empty.' },
  ]);
}

export function assignmentMissingError() {
  return new AppError('The selected assignment does not exist.', 400, [
    { field: 'assignment', message: 'Choose an assignment that exists, or leave it empty.' },
  ]);
}

// Confirms the target document exists AND write-locks it for the rest of the transaction, in one step.
// Throws `missingError()` if it does not exist. Call it BEFORE saving the record that points at it.
async function lockForReference(collection, id, session, missingError) {
  const result = await mongoose.connection
    .collection(collection)
    .updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $inc: { referenceVersion: 1 } }, { session });

  if (result.matchedCount === 0) throw missingError();
}

export const lockSubjectForReference = (subjectId, session) => lockForReference('subjects', subjectId, session, subjectMissingError);
export const lockAssignmentForReference = (assignmentId, session) => lockForReference('assignments', assignmentId, session, assignmentMissingError);

// For UPDATES: a record that changes (or sets) its reference locks the new target. A record that keeps the
// reference it already has needs no lock (the target cannot be deleted while the record points at it), but we
// still refuse to re-save a reference to a target that is somehow missing (damage made outside the app).
async function claimReference(collection, id, previousId, session, lock, missingError) {
  if (!id) return;
  if (previousId?.toString() !== id) return lock(id, session);
  const exists = await mongoose.connection.collection(collection).countDocuments({ _id: new mongoose.Types.ObjectId(id) }, { session });
  if (exists === 0) throw missingError();
}

export const claimSubject = (subjectId, previousId, session) =>
  claimReference('subjects', subjectId, previousId, session, lockSubjectForReference, subjectMissingError);
export const claimAssignment = (assignmentId, previousId, session) =>
  claimReference('assignments', assignmentId, previousId, session, lockAssignmentForReference, assignmentMissingError);
