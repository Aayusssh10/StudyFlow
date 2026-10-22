import Assignment from '../models/Assignment.js';
import StudySession from '../models/StudySession.js';
import Subject from '../models/Subject.js';
import Task from '../models/Task.js';
import { getTiming, timingFilter } from '../utils/assignmentTiming.js';
import { addDays, weekRange } from '../utils/dates.js';
import { summarizeSessions } from '../utils/studySummary.js';
import { getTaskTiming, taskTimingFilter } from '../utils/taskTiming.js';
import { parseNowQuery, parseWeekStartQuery } from '../validators/queryHelpers.js';

const DEADLINES_SHOWN = 8;
const TODAY_ITEMS_SHOWN = 20;
const ACTIVITY_SHOWN = 8;
const STATUSES = ['Not Started', 'In Progress', 'Completed'];

const SUBJECT_FIELDS = 'name code color';

// GET /api/dashboard/stats?now=YYYY-MM-DDTHH:mm&weekStart=monday|sunday
// EVERY number here is calculated from the stored records, with the same rules and filters the list pages use
// (assignmentTiming / taskTiming / studySummary), so the dashboard and the pages can never disagree.
// "now" is the browser's local date and time, so "today", "overdue" and "this week" follow the user's own clock.
export async function getDashboardStats(req, res) {
  const now = parseNowQuery(req.query);
  const today = now.date;
  const week = weekRange(today, parseWeekStartQuery(req.query));
  const last7From = addDays(today, -6);
  const pending = { status: { $ne: 'Completed' } };

  const [
    subjectCount,
    assignmentTotal,
    assignmentPending,
    assignmentCompleted,
    assignmentOverdue,
    assignmentDueSoon,
    statusRows,
    deadlines,
    tasksToday,
    tasksTodayDone,
    tasksOverdue,
    todayTasks,
    todaySessions,
    studyAll,
    studyToday,
    studyWeek,
    studyLast7,
    recentAssignments,
    recentTasks,
    recentSessions,
  ] = await Promise.all([
    Subject.countDocuments({}),
    Assignment.countDocuments({}),
    Assignment.countDocuments(pending),
    Assignment.countDocuments({ status: 'Completed' }),
    Assignment.countDocuments(timingFilter('overdue', now)),
    Assignment.countDocuments(timingFilter('dueSoon', now)),
    Assignment.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Assignment.find(pending).sort({ dueDate: 1, dueTime: 1, _id: 1 }).limit(DEADLINES_SHOWN).populate('subject', SUBJECT_FIELDS),
    Task.countDocuments({ date: today }),
    Task.countDocuments({ date: today, completed: true }),
    Task.countDocuments(taskTimingFilter('overdue', now)),
    Task.find({ date: today })
      .sort({ timeSort: 1, priorityRank: -1, _id: 1 })
      .limit(TODAY_ITEMS_SHOWN)
      .populate([
        { path: 'subject', select: SUBJECT_FIELDS },
        { path: 'assignment', select: 'title dueDate status subject', populate: { path: 'subject', select: SUBJECT_FIELDS } },
      ]),
    StudySession.find({ date: today })
      .sort({ startTime: 1, _id: 1 })
      .limit(TODAY_ITEMS_SHOWN)
      .populate([{ path: 'subject', select: SUBJECT_FIELDS }, { path: 'assignment', select: 'title' }]),
    summarizeSessions({}),
    summarizeSessions({ date: today }),
    summarizeSessions({ date: { $gte: week.from, $lte: week.to } }),
    summarizeSessions({ date: { $gte: last7From, $lte: today } }),
    Assignment.find({}).sort({ updatedAt: -1, _id: -1 }).limit(ACTIVITY_SHOWN),
    Task.find({}).sort({ updatedAt: -1, _id: -1 }).limit(ACTIVITY_SHOWN),
    StudySession.find({}).sort({ updatedAt: -1, _id: -1 }).limit(ACTIVITY_SHOWN).populate('subject', 'name'),
  ]);

  // The last 7 days (today and the 6 before), every day present, days without study showing 0.
  const minutesByDay = new Map(studyLast7.byDay.map((row) => [row.date, row.minutes]));
  const studyLast7Days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(last7From, i);
    return { date, minutes: minutesByDay.get(date) ?? 0 };
  });

  const countByStatus = new Map(statusRows.map((row) => [row._id, row.count]));
  const assignmentStatus = STATUSES.map((status) => ({ status, count: countByStatus.get(status) ?? 0 }));

  // Recent activity: the latest changes across assignments, tasks and sessions, newest first.
  const activity = [
    ...recentAssignments.map((a) => ({ type: 'assignment', id: a.id, title: a.title, at: a.updatedAt, created: a.createdAt })),
    ...recentTasks.map((t) => ({ type: 'task', id: t.id, title: t.title, at: t.updatedAt, created: t.createdAt })),
    ...recentSessions.map((s) => ({
      type: 'session',
      id: s.id,
      title: `${s.subject?.name ?? 'Unknown subject'}`,
      durationMinutes: s.durationMinutes,
      at: s.updatedAt,
      created: s.createdAt,
    })),
  ]
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
    .slice(0, ACTIVITY_SHOWN)
    .map(({ created, at, ...item }) => ({ ...item, action: created.getTime() === at.getTime() ? 'added' : 'updated', at: at.toISOString() }));

  res.json({
    success: true,
    data: {
      now,
      counts: {
        subjects: subjectCount,
        assignments: {
          total: assignmentTotal,
          pending: assignmentPending,
          completed: assignmentCompleted,
          overdue: assignmentOverdue,
          dueSoon: assignmentDueSoon,
        },
        tasks: { today: tasksToday, todayDone: tasksTodayDone, overdue: tasksOverdue },
        study: {
          todayMinutes: studyToday.totalMinutes,
          weekMinutes: studyWeek.totalMinutes,
          totalMinutes: studyAll.totalMinutes,
          sessionCount: studyAll.sessionCount,
          week,
        },
      },
      today: {
        tasks: todayTasks.map((task) => ({ ...task.toJSON(), timing: getTaskTiming(task, now) })),
        sessions: todaySessions.map((session) => session.toJSON()),
      },
      upcomingDeadlines: deadlines.map((assignment) => ({ ...assignment.toJSON(), timing: getTiming(assignment, now) })),
      studyLast7Days,
      assignmentStatus,
      recentActivity: activity,
    },
  });
}
