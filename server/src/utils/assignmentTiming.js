import { DUE_SOON_DAYS, addDays } from './dates.js';

export const TIMINGS = ['overdue', 'dueSoon', 'upcoming', 'completed'];

// Every assignment is in exactly ONE of these four groups:
//   completed - status is Completed (never counted as pending or overdue)
//   overdue   - not completed, and the due date (or due time today) has passed
//   dueSoon   - not completed, not overdue, due within the next DUE_SOON_DAYS days (including today)
//   upcoming  - not completed, due later than that
// `now` is { date: "YYYY-MM-DD", time: "HH:mm" } in the user's local time.
export function getTiming(assignment, now) {
  if (assignment.status === 'Completed') return 'completed';
  if (assignment.dueDate < now.date) return 'overdue';
  if (assignment.dueDate === now.date) {
    return assignment.dueTime && assignment.dueTime < now.time ? 'overdue' : 'dueSoon';
  }
  return assignment.dueDate <= addDays(now.date, DUE_SOON_DAYS) ? 'dueSoon' : 'upcoming';
}

// The same four groups as a database filter, so listing can filter by them.
// A due time of '' (none) is skipped by `$gt: ''`.
export function timingFilter(timing, now) {
  const pending = { status: { $ne: 'Completed' } };
  const passedToday = { dueDate: now.date, dueTime: { $gt: '', $lt: now.time } };
  const soonEnd = addDays(now.date, DUE_SOON_DAYS);

  switch (timing) {
    case 'completed':
      return { status: 'Completed' };
    case 'overdue':
      return { ...pending, $or: [{ dueDate: { $lt: now.date } }, passedToday] };
    case 'dueSoon':
      return { ...pending, dueDate: { $gte: now.date, $lte: soonEnd }, $nor: [passedToday] };
    case 'upcoming':
      return { ...pending, dueDate: { $gt: soonEnd } };
    default:
      return {};
  }
}
