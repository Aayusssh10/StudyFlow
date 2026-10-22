import mongoose from 'mongoose';
import Assignment from '../models/Assignment.js';
import { AppError } from '../utils/AppError.js';
import { getTiming } from '../utils/assignmentTiming.js';
import { ASSIGNMENT_DEPENDENTS } from '../utils/subjectReferences.js';
import { claimSubject, inTransaction, lockSubjectForReference } from '../utils/transaction.js';
import { parseAssignmentQuery } from '../validators/assignmentQueryValidator.js';
import { parseNowQuery } from '../validators/queryHelpers.js';
import { validateAssignmentInput, validateStatusInput } from '../validators/assignmentValidator.js';

const SUBJECT_FIELDS = 'name code color';

// --- helpers -----------------------------------------------------------------------------------
const present = (assignment, now) => ({ ...assignment.toJSON(), timing: getTiming(assignment, now) });

async function findAssignmentOr404(id) {
  const assignment = await Assignment.findById(id);
  if (!assignment) throw new AppError('Assignment not found.', 404);
  return assignment;
}

// Reloads an assignment with its subject's name/color filled in, for the response.
async function loadForResponse(id, now) {
  const assignment = await Assignment.findById(id).populate('subject', SUBJECT_FIELDS);
  if (!assignment) throw new AppError('Assignment not found.', 404);
  return present(assignment, now);
}

// --- handlers ----------------------------------------------------------------------------------
export async function listAssignments(req, res) {
  const { filter, sort, page, limit, now } = parseAssignmentQuery(req.query);

  const [assignments, total] = await Promise.all([
    Assignment.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('subject', SUBJECT_FIELDS),
    Assignment.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: assignments.map((assignment) => present(assignment, now)),
    meta: { total, page, limit },
  });
}

export async function getAssignment(req, res) {
  const now = parseNowQuery(req.query);
  res.json({ success: true, data: await loadForResponse(req.params.id, now) });
}

// The subject check and the save are ONE transaction, and the check write-locks the subject
// (see utils/transaction.js). A subject deleted at the same moment, or a crash halfway, can never
// leave an assignment pointing at a missing subject.
export async function createAssignment(req, res) {
  const now = parseNowQuery(req.query);
  const input = validateAssignmentInput(req);

  const created = await inTransaction(async (session) => {
    if (input.subject) await lockSubjectForReference(input.subject, session);
    const [assignment] = await Assignment.create([input], { session });
    return assignment;
  });

  res.status(201).json({ success: true, data: await loadForResponse(created._id, now) });
}

// PUT replaces all editable fields: send the full form. Optional fields left out become empty.
export async function updateAssignment(req, res) {
  const now = parseNowQuery(req.query);
  const input = validateAssignmentInput(req);

  await inTransaction(async (session) => {
    const assignment = await Assignment.findById(req.params.id).session(session);
    if (!assignment) throw new AppError('Assignment not found.', 404);

    await claimSubject(input.subject, assignment.subject, session);

    assignment.set(input);
    await assignment.save({ session });
  });

  res.json({ success: true, data: await loadForResponse(req.params.id, now) });
}

// PATCH /:id/status - quick "mark complete" / "start" without sending the whole form.
export async function updateAssignmentStatus(req, res) {
  const now = parseNowQuery(req.query);
  const status = validateStatusInput(req);
  const assignment = await findAssignmentOr404(req.params.id);

  assignment.status = status;
  await assignment.save();
  res.json({ success: true, data: await loadForResponse(assignment._id, now) });
}

// Deleting an assignment keeps the tasks (and later study sessions) that point at it and CLEARS their link.
// The delete and the un-linking are ONE transaction. Deleting writes the assignment document, which conflicts
// with any in-flight request that is attaching something to it (see utils/transaction.js), so a link can
// never be created after the clean-up and left pointing at the deleted assignment.
export async function deleteAssignment(req, res) {
  await inTransaction(async (session) => {
    const result = await Assignment.deleteOne({ _id: req.params.id }, { session });
    if (result.deletedCount === 0) throw new AppError('Assignment not found.', 404);

    for (const dependent of ASSIGNMENT_DEPENDENTS) {
      await mongoose.connection
        .collection(dependent.collection)
        .updateMany({ [dependent.field]: new mongoose.Types.ObjectId(req.params.id) }, { $set: { [dependent.field]: null, updatedAt: new Date() } }, { session });
    }
  });

  res.json({ success: true, data: { id: req.params.id } });
}
