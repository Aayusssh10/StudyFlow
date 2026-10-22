export const TASK_TIMINGS = ['overdue', 'today', 'upcoming', 'completed'];

// Every task is in exactly ONE of these four groups (`now` is { date, time } in the user's local time):
//   completed - done (never counted as overdue, however old)
//   overdue   - not done, and its day (or its time today) has passed
//   today     - not done, planned for today and not yet past its time
//   upcoming  - not done, planned for a later day
export function getTaskTiming(task, now) {
  if (task.completed) return 'completed';
  if (task.date < now.date) return 'overdue';
  if (task.date === now.date) return task.time && task.time < now.time ? 'overdue' : 'today';
  return 'upcoming';
}

// The same four groups as a database filter. A time of '' (none) is skipped by `$gt: ''`.
export function taskTimingFilter(timing, now) {
  const open = { completed: false };
  const passedToday = { date: now.date, time: { $gt: '', $lt: now.time } };

  switch (timing) {
    case 'completed':
      return { completed: true };
    case 'overdue':
      return { ...open, $or: [{ date: { $lt: now.date } }, passedToday] };
    case 'today':
      return { ...open, date: now.date, $nor: [passedToday] };
    case 'upcoming':
      return { ...open, date: { $gt: now.date } };
    default:
      return {};
  }
}
