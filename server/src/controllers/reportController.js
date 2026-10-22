import Assignment, { STATUSES } from '../models/Assignment.js';
import StudySession from '../models/StudySession.js';
import Task from '../models/Task.js';
import { AppError } from '../utils/AppError.js';
import { getTiming, timingFilter } from '../utils/assignmentTiming.js';
import { toCsv } from '../utils/csv.js';
import { weekRange } from '../utils/dates.js';
import { taskSubjectCondition } from '../utils/subjectFilters.js';
import { summarizeSessions } from '../utils/studySummary.js';
import { getTaskTiming, taskTimingFilter } from '../utils/taskTiming.js';
import { parseReportQuery } from '../validators/reportQueryValidator.js';

// An export of more rows than this is refused (with a message to narrow the range) instead of building a huge file.
export const MAX_EXPORT_ROWS = 10000;

const SUBJECT_FIELDS = 'name code color';

// "from"/"to" are optional, so a filter can be open at either end (or both: all time).
const dayRange = (field, from, to) => {
  if (!from && !to) return {};
  return { [field]: { ...(from && { $gte: from }), ...(to && { $lte: to }) } };
};

// Percentage of `part` in `total`, or null when there is nothing to divide: "no data" is never shown as 0%.
const percent = (part, total) => (total === 0 ? null : Math.round((part / total) * 100));

// The three kinds of record, filtered the same way for the summary and for the exports:
// assignments by DUE DATE, tasks by their DAY, study sessions by their DATE; all optionally by subject.
async function buildFilters({ from, to, subject }) {
  return {
    assignments: { ...dayRange('dueDate', from, to), ...(subject && { subject }) },
    tasks: { ...dayRange('date', from, to), ...(subject && (await taskSubjectCondition(subject))) },
    sessions: { ...dayRange('date', from, to), ...(subject && { subject }) },
  };
}

// GET /api/reports/summary - every figure is calculated from the saved records; nothing is stored.
export async function getSummary(req, res) {
  const query = parseReportQuery(req.query);
  const { now, weekStart } = query;
  const filters = await buildFilters(query);
  const both = (filter, extra) => ({ $and: [filter, extra] });

  const [
    assignmentTotal,
    assignmentCompleted,
    assignmentOverdue,
    assignmentDueSoon,
    statusRows,
    taskTotal,
    taskCompleted,
    taskOverdue,
    study,
  ] = await Promise.all([
    Assignment.countDocuments(filters.assignments),
    Assignment.countDocuments(both(filters.assignments, { status: 'Completed' })),
    Assignment.countDocuments(both(filters.assignments, timingFilter('overdue', now))),
    Assignment.countDocuments(both(filters.assignments, timingFilter('dueSoon', now))),
    Assignment.aggregate([{ $match: filters.assignments }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Task.countDocuments(filters.tasks),
    Task.countDocuments(both(filters.tasks, { completed: true })),
    Task.countDocuments(both(filters.tasks, taskTimingFilter('overdue', now))),
    summarizeSessions(filters.sessions),
  ]);

  const countByStatus = new Map(statusRows.map((row) => [row._id, row.count]));
  const weeks = new Map();
  for (const day of study.byDay) {
    const { from: start, to: end } = weekRange(day.date, weekStart);
    const week = weeks.get(start) ?? { weekStart: start, weekEnd: end, minutes: 0, sessions: 0 };
    week.minutes += day.minutes;
    week.sessions += day.sessions;
    weeks.set(start, week);
  }
  const activeDays = study.byDay.length;

  res.json({
    success: true,
    data: {
      filter: { from: query.from ?? null, to: query.to ?? null, subject: query.subject?.toString() ?? null, weekStart },
      now,
      assignments: {
        total: assignmentTotal,
        completed: assignmentCompleted,
        pending: assignmentTotal - assignmentCompleted,
        overdue: assignmentOverdue,
        dueSoon: assignmentDueSoon,
        completionPercent: percent(assignmentCompleted, assignmentTotal),
        statusDistribution: STATUSES.map((status) => ({ status, count: countByStatus.get(status) ?? 0 })),
      },
      tasks: {
        total: taskTotal,
        completed: taskCompleted,
        pending: taskTotal - taskCompleted,
        overdue: taskOverdue,
        completionPercent: percent(taskCompleted, taskTotal),
      },
      study: {
        totalMinutes: study.totalMinutes,
        sessionCount: study.sessionCount,
        activeDays,
        averageMinutesPerActiveDay: activeDays === 0 ? null : Math.round(study.totalMinutes / activeDays),
        byDay: study.byDay,
        byWeek: [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
        bySubject: study.bySubject,
      },
    },
  });
}

const subjectName = (subject) => subject?.name ?? '';

// What each export contains. Dates and times stay plain text ("2026-10-21", "14:30"), durations are numbers.
const EXPORTS = {
  assignments: {
    columns: [
      { label: 'Title', value: (a) => a.title },
      { label: 'Subject', value: (a) => subjectName(a.subject) },
      { label: 'Type', value: (a) => a.type },
      { label: 'Priority', value: (a) => a.priority },
      { label: 'Status', value: (a) => a.status },
      { label: 'Due date', value: (a) => a.dueDate },
      { label: 'Due time', value: (a) => a.dueTime },
      { label: 'Estimated minutes', value: (a) => a.estimatedMinutes },
      { label: 'Deadline', value: (a, now) => getTiming(a, now) },
      { label: 'Description', value: (a) => a.description },
    ],
    load: (filters) =>
      Assignment.find(filters.assignments).sort({ dueDate: 1, dueTime: 1, _id: 1 }).limit(MAX_EXPORT_ROWS).populate('subject', SUBJECT_FIELDS),
    count: (filters) => Assignment.countDocuments(filters.assignments),
  },
  tasks: {
    columns: [
      { label: 'Title', value: (t) => t.title },
      { label: 'Date', value: (t) => t.date },
      { label: 'Time', value: (t) => t.time },
      { label: 'Priority', value: (t) => t.priority },
      { label: 'Done', value: (t) => t.completed },
      // a task linked to an assignment shows that assignment's subject (read from the assignment, never copied)
      { label: 'Subject', value: (t) => subjectName(t.subject ?? t.assignment?.subject) },
      { label: 'Assignment', value: (t) => t.assignment?.title ?? '' },
      { label: 'Timing', value: (t, now) => getTaskTiming(t, now) },
      { label: 'Description', value: (t) => t.description },
    ],
    load: (filters) =>
      Task.find(filters.tasks)
        .sort({ date: 1, timeSort: 1, _id: 1 })
        .limit(MAX_EXPORT_ROWS)
        .populate([
          { path: 'subject', select: SUBJECT_FIELDS },
          { path: 'assignment', select: 'title subject', populate: { path: 'subject', select: SUBJECT_FIELDS } },
        ]),
    count: (filters) => Task.countDocuments(filters.tasks),
  },
  'study-sessions': {
    columns: [
      { label: 'Date', value: (s) => s.date },
      { label: 'Start time', value: (s) => s.startTime },
      { label: 'Duration (minutes)', value: (s) => s.durationMinutes },
      { label: 'Subject', value: (s) => subjectName(s.subject) },
      { label: 'Assignment', value: (s) => s.assignment?.title ?? '' },
      { label: 'Type', value: (s) => s.type },
      { label: 'Notes', value: (s) => s.notes },
    ],
    load: (filters) =>
      StudySession.find(filters.sessions)
        .sort({ date: 1, startTime: 1, _id: 1 })
        .limit(MAX_EXPORT_ROWS)
        .populate([
          { path: 'subject', select: SUBJECT_FIELDS },
          { path: 'assignment', select: 'title' },
        ]),
    count: (filters) => StudySession.countDocuments(filters.sessions),
  },
};

// GET /api/reports/export?type=assignments|tasks|study-sessions&from&to&subject&now - a CSV file download.
export async function exportCsv(req, res) {
  const query = parseReportQuery(req.query, { exporting: true });
  const exporter = EXPORTS[query.type];
  const filters = await buildFilters(query);

  if ((await exporter.count(filters)) > MAX_EXPORT_ROWS) {
    throw new AppError(`This export has more than ${MAX_EXPORT_ROWS} rows. Choose a shorter date range.`, 400);
  }
  const rows = await exporter.load(filters);
  const csv = toCsv(exporter.columns.map((column) => ({ ...column, value: (row) => column.value(row, query.now) })), rows);

  res
    .type('text/csv; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="studyflow-${query.type}-${query.now.date}.csv"`)
    .set('Cache-Control', 'no-store')
    // the byte-order mark makes Excel read accented characters correctly
    .send(`﻿${csv}`);
}
