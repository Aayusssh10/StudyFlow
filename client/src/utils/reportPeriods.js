import { shiftMonth } from './calendar.js'
import { addDays, formatDate, formatDayLabel, weekRange } from './dates.js'

export const PERIODS = [
  { value: 'week', label: 'This week' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
]

// The days a period covers, as { from, to } ("" = no limit on that side: "All time" has neither).
export function periodRange(period, today, custom = { from: '', to: '' }) {
  switch (period) {
    case 'week':
      return weekRange(today)
    case 'last7':
      return { from: addDays(today, -6), to: today }
    case 'last30':
      return { from: addDays(today, -29), to: today }
    case 'month': {
      const first = `${today.slice(0, 7)}-01`
      return { from: first, to: addDays(shiftMonth(first, 1), -1) }
    }
    case 'custom':
      return { from: custom.from, to: custom.to }
    default:
      return { from: '', to: '' }
  }
}

// Every day from..to as a list, or null when there are more than `limit` of them.
function listDays(from, to, limit) {
  const days = []
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (days.length >= limit) return null
    days.push(day)
  }
  return days
}

const DAILY_LIMIT = 31
const WEEKLY_FILL_LIMIT = 60

// The bars of the "study time over time" chart. A short range shows every day (days without study as 0);
// a longer one shows weeks (also filled when the range has a start and an end and is not huge).
// Returns { kind: 'day' | 'week', points: [{ key, label, title, minutes }] }.
export function studyPoints(study, { from, to }) {
  const days = from && to ? listDays(from, to, DAILY_LIMIT) : null
  if (days) {
    const minutes = new Map(study.byDay.map((row) => [row.date, row.minutes]))
    return {
      kind: 'day',
      points: days.map((date) => ({ key: date, label: formatDayLabel(date), title: formatDate(date), minutes: minutes.get(date) ?? 0 })),
    }
  }

  const byStart = new Map(study.byWeek.map((row) => [row.weekStart, row.minutes]))
  let starts = study.byWeek.map((row) => row.weekStart)
  if (from && to) {
    const filled = []
    for (let start = weekRange(from).from; start <= to && filled.length <= WEEKLY_FILL_LIMIT; start = addDays(start, 7)) filled.push(start)
    if (filled.length <= WEEKLY_FILL_LIMIT) starts = filled
  }
  return {
    kind: 'week',
    points: starts.map((start) => ({
      key: start,
      label: formatDayLabel(start),
      title: `Week of ${formatDate(start)}`,
      minutes: byStart.get(start) ?? 0,
    })),
  }
}
