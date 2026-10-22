import Task from '../models/Task.js';
import { AppError } from '../utils/AppError.js';
import { getTaskTiming } from '../utils/taskTiming.js';
import { claimAssignment, claimSubject, inTransaction, lockAssignmentForReference, lockSubjectForReference } from '../utils/transaction.js';
import { parseNowQuery } from '../validators/queryHelpers.js';
import { parseTaskQuery } from '../validators/taskQueryValidator.js';
import { validateCompletedInput, validateTaskInput } from '../validators/taskValidator.js';

// A task linked to an assignment shows that assignment's subject too (read from the assignment, never copied).
const POPULATE = [
  { path: 'subject', select: 'name code color' },
  { path: 'assignment', select: 'title dueDate status subject', populate: { path: 'subject', select: 'name code color' } },
];

const present = (task, now) => ({ ...task.toJSON(), timing: getTaskTiming(task, now) });

async function loadForResponse(id, now) {
  const task = await Task.findById(id).populate(POPULATE);
  if (!task) throw new AppError('Task not found.', 404);
  return present(task, now);
}

export async function listTasks(req, res) {
  const { filter, sort, page, limit, now } = parseTaskQuery(req.query);

  const [tasks, total] = await Promise.all([
    Task.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate(POPULATE),
    Task.countDocuments(filter),
  ]);

  res.json({ success: true, data: tasks.map((task) => present(task, now)), meta: { total, page, limit } });
}

export async function getTask(req, res) {
  const now = parseNowQuery(req.query);
  res.json({ success: true, data: await loadForResponse(req.params.id, now) });
}

// Creating a task that links a subject or an assignment is ONE transaction that first locks the target
// (see utils/transaction.js). The target being deleted at the same moment, or a crash halfway, can never
// leave a task pointing at something that does not exist.
export async function createTask(req, res) {
  const now = parseNowQuery(req.query);
  const input = validateTaskInput(req);

  const created = await inTransaction(async (session) => {
    if (input.subject) await lockSubjectForReference(input.subject, session);
    if (input.assignment) await lockAssignmentForReference(input.assignment, session);
    const [task] = await Task.create([input], { session });
    return task;
  });

  res.status(201).json({ success: true, data: await loadForResponse(created._id, now) });
}

// PUT replaces all editable fields: send the full form. Optional fields left out become empty.
export async function updateTask(req, res) {
  const now = parseNowQuery(req.query);
  const input = validateTaskInput(req);

  await inTransaction(async (session) => {
    const task = await Task.findById(req.params.id).session(session);
    if (!task) throw new AppError('Task not found.', 404);

    await claimSubject(input.subject, task.subject, session);
    await claimAssignment(input.assignment, task.assignment, session);

    task.set(input);
    await task.save({ session });
  });

  res.json({ success: true, data: await loadForResponse(req.params.id, now) });
}

// PATCH /:id/completed - tick a task off (or untick it) without sending the whole form.
export async function updateTaskCompleted(req, res) {
  const now = parseNowQuery(req.query);
  const completed = validateCompletedInput(req);
  const task = await Task.findById(req.params.id);
  if (!task) throw new AppError('Task not found.', 404);

  task.completed = completed;
  await task.save();
  res.json({ success: true, data: await loadForResponse(task._id, now) });
}

export async function deleteTask(req, res) {
  const result = await Task.deleteOne({ _id: req.params.id });
  if (result.deletedCount === 0) throw new AppError('Task not found.', 404);
  res.json({ success: true, data: { id: req.params.id } });
}
