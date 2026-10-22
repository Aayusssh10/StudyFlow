import StudySession from '../models/StudySession.js';
import { AppError } from '../utils/AppError.js';
import { summarizeSessions } from '../utils/studySummary.js';
import { claimAssignment, claimSubject, inTransaction, lockAssignmentForReference, lockSubjectForReference } from '../utils/transaction.js';
import { parseSessionQuery, parseSummaryQuery } from '../validators/studySessionQueryValidator.js';
import { validateStudySessionInput } from '../validators/studySessionValidator.js';

const POPULATE = [
  { path: 'subject', select: 'name code color' },
  { path: 'assignment', select: 'title dueDate status' },
];

async function loadForResponse(id) {
  const session = await StudySession.findById(id).populate(POPULATE);
  if (!session) throw new AppError('Study session not found.', 404);
  return session.toJSON();
}

export async function listSessions(req, res) {
  const { filter, sort, page, limit } = parseSessionQuery(req.query);

  const [sessions, total] = await Promise.all([
    StudySession.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate(POPULATE),
    StudySession.countDocuments(filter),
  ]);

  res.json({ success: true, data: sessions.map((session) => session.toJSON()), meta: { total, page, limit } });
}

// Study-time totals, CALCULATED from the stored sessions that match the same filters as the list
// (shared with the dashboard: see utils/studySummary.js).
export async function getSummary(req, res) {
  const { filter } = parseSummaryQuery(req.query);
  res.json({ success: true, data: await summarizeSessions(filter) });
}

export async function getSession(req, res) {
  res.json({ success: true, data: await loadForResponse(req.params.id) });
}

// Saving a session locks its subject (and assignment) inside ONE transaction first (see utils/transaction.js),
// so the subject or assignment being deleted at the same moment, or a crash halfway, can never leave a session
// pointing at something that does not exist.
export async function createSession(req, res) {
  const input = validateStudySessionInput(req);

  const created = await inTransaction(async (session) => {
    await lockSubjectForReference(input.subject, session);
    if (input.assignment) await lockAssignmentForReference(input.assignment, session);
    const [studySession] = await StudySession.create([input], { session });
    return studySession;
  });

  res.status(201).json({ success: true, data: await loadForResponse(created._id) });
}

// PUT replaces all editable fields: send the full form. Optional fields left out become empty.
export async function updateSession(req, res) {
  const input = validateStudySessionInput(req);

  await inTransaction(async (session) => {
    const studySession = await StudySession.findById(req.params.id).session(session);
    if (!studySession) throw new AppError('Study session not found.', 404);

    await claimSubject(input.subject, studySession.subject, session);
    await claimAssignment(input.assignment, studySession.assignment, session);

    studySession.set(input);
    await studySession.save({ session });
  });

  res.json({ success: true, data: await loadForResponse(req.params.id) });
}

export async function deleteSession(req, res) {
  const result = await StudySession.deleteOne({ _id: req.params.id });
  if (result.deletedCount === 0) throw new AppError('Study session not found.', 404);
  res.json({ success: true, data: { id: req.params.id } });
}
