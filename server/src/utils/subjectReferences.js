import mongoose from 'mongoose';

// === The map of who points at whom ===========================================================
// MongoDB has no foreign keys, so the application keeps this map. Collections are listed by name so it works
// even before a model exists; each feature uses the default collection name and the field name shown here.
// Every write that creates or changes one of these references must follow utils/transaction.js.

// Records that point at a SUBJECT. Deleting a subject that is still referenced is refused.
export const SUBJECT_DEPENDENTS = [
  { collection: 'assignments', field: 'subject', singular: 'assignment', plural: 'assignments' },
  { collection: 'tasks', field: 'subject', singular: 'task', plural: 'tasks' },
  { collection: 'studysessions', field: 'subject', singular: 'study session', plural: 'study sessions' },
];

// Records that point at an ASSIGNMENT. Deleting an assignment is allowed: it clears these links
// (the tasks and study sessions stay, just unlinked).
export const ASSIGNMENT_DEPENDENTS = [
  { collection: 'tasks', field: 'assignment' },
  { collection: 'studysessions', field: 'assignment' },
];

// Every reference in the data model, used by the read-only integrity checker (utils/integrity.js).
export const ALL_REFERENCES = [
  ...SUBJECT_DEPENDENTS.map(({ collection, field }) => ({ collection, field, target: 'subjects' })),
  ...ASSIGNMENT_DEPENDENTS.map(({ collection, field }) => ({ collection, field, target: 'assignments' })),
];

// Returns a readable summary like "3 assignments and 1 study session", or '' if the subject is unused.
// Pass the transaction's `session` so the counts come from the same consistent snapshot as the delete.
export async function describeSubjectUsage(subjectId, session) {
  const id = new mongoose.Types.ObjectId(subjectId);
  const parts = [];

  for (const dependent of SUBJECT_DEPENDENTS) {
    const count = await mongoose.connection
      .collection(dependent.collection)
      .countDocuments({ [dependent.field]: id }, { session });
    if (count > 0) parts.push(`${count} ${count === 1 ? dependent.singular : dependent.plural}`);
  }

  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
