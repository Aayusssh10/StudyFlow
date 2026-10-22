import Assignment from '../models/Assignment.js';

// A task belongs to a subject directly OR through its assignment (an assignment's subject is never copied into the
// task). This is the database condition for "tasks of this subject"; the calendar and the reports both use it.
export async function taskSubjectCondition(subjectId) {
  const assignmentIds = await Assignment.find({ subject: subjectId }).distinct('_id');
  return { $or: [{ subject: subjectId }, { assignment: { $in: assignmentIds } }] };
}
