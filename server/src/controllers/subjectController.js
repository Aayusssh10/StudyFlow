import Subject, { NAME_COLLATION } from '../models/Subject.js';
import { AppError } from '../utils/AppError.js';
import { describeSubjectUsage } from '../utils/subjectReferences.js';
import { inTransaction } from '../utils/transaction.js';
import { validateSubjectInput } from '../validators/subjectValidator.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function parsePositiveInt(value, fallback, max = Infinity) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}

async function assertNameIsFree(name, ignoreId) {
  const filter = { name };
  if (ignoreId) filter._id = { $ne: ignoreId };
  const existing = await Subject.findOne(filter).collation(NAME_COLLATION).select('_id');
  if (existing) {
    throw new AppError(`A subject named "${name}" already exists.`, 409, [
      { field: 'name', message: 'This name is already used by another subject.' },
    ]);
  }
}

async function findSubjectOr404(id) {
  const subject = await Subject.findById(id);
  if (!subject) throw new AppError('Subject not found.', 404);
  return subject;
}

export async function listSubjects(req, res) {
  const page = parsePositiveInt(req.query.page, 1);
  const limit = parsePositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);

  const [subjects, total] = await Promise.all([
    Subject.find()
      .collation(NAME_COLLATION)
      .sort({ name: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Subject.countDocuments(),
  ]);

  res.json({ success: true, data: subjects, meta: { total, page, limit } });
}

export async function getSubject(req, res) {
  res.json({ success: true, data: await findSubjectOr404(req.params.id) });
}

export async function createSubject(req, res) {
  const input = validateSubjectInput(req);
  await assertNameIsFree(input.name);
  const subject = await Subject.create(input);
  res.status(201).json({ success: true, data: subject });
}

// PUT replaces all editable fields: send the full form. Optional fields left out become empty.
export async function updateSubject(req, res) {
  const subject = await findSubjectOr404(req.params.id);
  const input = validateSubjectInput(req);
  await assertNameIsFree(input.name, subject._id);

  subject.set(input);
  await subject.save();
  res.json({ success: true, data: subject });
}

// "Check that nothing uses the subject" and "delete it" happen in ONE transaction. Deleting writes to the
// subject document, which conflicts with any in-flight request that is creating a reference to it
// (see utils/transaction.js), so a reference can never slip in between the check and the delete.
export async function deleteSubject(req, res) {
  await inTransaction(async (session) => {
    const subject = await Subject.findById(req.params.id).session(session);
    if (!subject) throw new AppError('Subject not found.', 404);

    const usage = await describeSubjectUsage(subject._id, session);
    if (usage) {
      throw new AppError(`Cannot delete "${subject.name}" because it is still used by ${usage}. Delete or reassign them first.`, 409);
    }

    const result = await Subject.deleteOne({ _id: subject._id }, { session });
    if (result.deletedCount === 0) throw new AppError('Subject not found.', 404);
  });

  res.json({ success: true, data: { id: req.params.id } });
}
