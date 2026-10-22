import Assignment from '../models/Assignment.js';
import StudySession from '../models/StudySession.js';
import Task from '../models/Task.js';
import { getTiming } from '../utils/assignmentTiming.js';
import { taskSubjectCondition } from '../utils/subjectFilters.js';
import { getTaskTiming } from '../utils/taskTiming.js';
import { EVENT_TYPES, parseCalendarQuery } from '../validators/calendarQueryValidator.js';

// Most events of ONE kind returned for one request. A month never gets near this; it only stops a huge range from
// producing a huge response, and `truncated` tells the page when it happened.
export const MAX_EVENTS_PER_TYPE = 500;

const SUBJECT_FIELDS = 'name code color';
const TYPE_ORDER = { assignment: 0, task: 1, session: 2 };

// A subject as the calendar shows it. null when the subject is missing (damage made outside the app).
const subjectInfo = (subject) => (subject ? { id: subject.id, name: subject.name, color: subject.color } : null);

function assignmentEvent(assignment, now) {
  return {
    id: assignment.id,
    type: 'assignment',
    date: assignment.dueDate,
    time: assignment.dueTime,
    title: assignment.title,
    subject: subjectInfo(assignment.subject),
    status: assignment.status,
    priority: assignment.priority,
    timing: getTiming(assignment, now),
  };
}

// A task linked to an assignment takes that assignment's subject (the same rule as the Tasks page).
function taskEvent(task, now) {
  return {
    id: task.id,
    type: 'task',
    date: task.date,
    time: task.time,
    title: task.title,
    subject: subjectInfo(task.subject ?? task.assignment?.subject),
    assignmentTitle: task.assignment?.title ?? null,
    completed: task.completed,
    priority: task.priority,
    timing: getTaskTiming(task, now),
  };
}

// A session is "planned" while it is still ahead of the user's clock (a later day, or later today),
// and "recorded" once it has happened. Sessions are always entered as minutes, so the label is the only difference.
function sessionEvent(session, now) {
  const planned = session.date > now.date || (session.date === now.date && session.startTime !== '' && session.startTime > now.time);
  return {
    id: session.id,
    type: 'session',
    date: session.date,
    time: session.startTime,
    title: session.subject?.name ? `Study: ${session.subject.name}` : 'Study session',
    subject: subjectInfo(session.subject),
    assignmentTitle: session.assignment?.title ?? null,
    durationMinutes: session.durationMinutes,
    sessionType: session.type,
    state: planned ? 'planned' : 'recorded',
  };
}

// Date first, then time (events without a time come last that day), then kind, then id: a stable, predictable order.
const byDayThenTime = (a, b) =>
  a.date.localeCompare(b.date) ||
  (a.time || '99:99').localeCompare(b.time || '99:99') ||
  TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
  a.id.localeCompare(b.id);

// GET /api/calendar - everything that falls on the days from..to, read from the same collections (and shown with the
// same timing rules) as the Assignments, Tasks and Study sessions pages. Nothing is stored for the calendar itself.
export async function getCalendar(req, res) {
  const { from, to, types, subject, now } = parseCalendarQuery(req.query);
  const range = (field) => ({ [field]: { $gte: from, $lte: to } });
  const limit = MAX_EVENTS_PER_TYPE + 1; // one extra row tells us the cap was reached
  const truncated = { assignment: false, task: false, session: false };
  const events = [];

  const take = (rows, kind, toEvent) => {
    truncated[kind] = rows.length > MAX_EVENTS_PER_TYPE;
    events.push(...rows.slice(0, MAX_EVENTS_PER_TYPE).map((row) => toEvent(row, now)));
  };

  await Promise.all([
    types.includes('assignment') &&
      Assignment.find({ ...range('dueDate'), ...(subject && { subject }) })
        .sort({ dueDate: 1, _id: 1 })
        .limit(limit)
        .populate('subject', SUBJECT_FIELDS)
        .then((rows) => take(rows, 'assignment', assignmentEvent)),
    types.includes('task') &&
      (async () => {
        // A task belongs to a subject directly OR through its assignment.
        const filter = range('date');
        if (subject) Object.assign(filter, await taskSubjectCondition(subject));
        const rows = await Task.find(filter)
          .sort({ date: 1, _id: 1 })
          .limit(limit)
          .populate([
            { path: 'subject', select: SUBJECT_FIELDS },
            { path: 'assignment', select: 'title subject', populate: { path: 'subject', select: SUBJECT_FIELDS } },
          ]);
        take(rows, 'task', taskEvent);
      })(),
    types.includes('session') &&
      StudySession.find({ ...range('date'), ...(subject && { subject }) })
        .sort({ date: 1, _id: 1 })
        .limit(limit)
        .populate([
          { path: 'subject', select: SUBJECT_FIELDS },
          { path: 'assignment', select: 'title' },
        ])
        .then((rows) => take(rows, 'session', sessionEvent)),
  ]);

  events.sort(byDayThenTime);

  res.json({
    success: true,
    data: { from, to, types, events, truncated: EVENT_TYPES.filter((kind) => truncated[kind]) },
  });
}
