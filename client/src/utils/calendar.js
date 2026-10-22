import { addDays, formatMinutes, weekRange } from './dates.js'

const pad = (number) => String(number).padStart(2, '0')

export const EVENT_KINDS = [
  { type: 'assignment', label: 'Assignment deadlines' },
  { type: 'task', label: 'Tasks' },
  { type: 'session', label: 'Study sessions' },
]

// "2026-10-21" -> "2026-10-01"
const firstOfMonth = (dateString) => `${dateString.slice(0, 7)}-01`

// The same day-of-month one month earlier/later is not always real (31 Oct + 1 month), so months move from their 1st.
export function shiftMonth(dateString, delta) {
  const [year, month] = dateString.split('-').map(Number)
  const shifted = new Date(year, month - 1 + delta, 1)
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-01`
}

// The days shown for a view: a month is padded to whole Monday-to-Sunday weeks (at most 6 weeks = 42 days);
// a week is its 7 days. Returns { from, to, days: ['YYYY-MM-DD', ...] }.
export function visibleRange(view, anchor) {
  let from
  let to
  if (view === 'week') {
    ;({ from, to } = weekRange(anchor))
  } else {
    const first = firstOfMonth(anchor)
    const last = addDays(shiftMonth(first, 1), -1)
    from = weekRange(first).from
    to = weekRange(last).to
  }
  const days = []
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day)
  return { from, to, days }
}

// Moving earlier/later: a month view jumps a month, a week view a week.
export const shiftAnchor = (view, anchor, delta) => (view === 'week' ? addDays(anchor, 7 * delta) : shiftMonth(anchor, delta))

// The words used for an event everywhere in the calendar (so state is never shown by colour alone).
export function eventLabel(event) {
  if (event.type === 'assignment') {
    const suffix = event.timing === 'overdue' ? ' (overdue)' : event.timing === 'completed' ? ' (completed)' : ''
    return `Due: ${event.title}${suffix}`
  }
  if (event.type === 'task') {
    const suffix = event.timing === 'overdue' ? ' (overdue)' : event.timing === 'completed' ? ' (done)' : ''
    return `Task: ${event.title}${suffix}`
  }
  const kind = event.state === 'planned' ? 'Planned study' : 'Studied'
  return `${kind}: ${event.subject?.name ?? 'Unknown subject'} (${formatMinutes(event.durationMinutes)})`
}

export const groupByDay = (events) => {
  const groups = new Map()
  for (const event of events) groups.set(event.date, [...(groups.get(event.date) ?? []), event])
  return groups
}
