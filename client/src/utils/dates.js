// Due dates are plain "YYYY-MM-DD" text and times are "HH:mm" text. They are never converted
// through UTC, so a due date can never shift by a day because of the time zone.

import { getSettings } from './settings.js'

const pad = (number) => String(number).padStart(2, '0')

// The user's current local date and time, e.g. "2026-10-21T14:30". Sent to the server as ?now=
// so "overdue" and "due soon" follow the clock on the user's own computer.
export function localNowParam(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// Today's date on the user's computer, as "YYYY-MM-DD".
export const todayString = () => localNowParam().slice(0, 10)

// "2026-10-25" + 3 days -> "2026-10-28". Uses plain calendar arithmetic, so daylight-saving changes cannot skew it.
export function addDays(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number)
  const shifted = new Date(year, month - 1, day + days)
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`
}

// The 7-day week that contains `dateString`, as { from, to } ("YYYY-MM-DD" each). It starts on the day chosen in
// Settings (Monday unless changed); pass `weekStart` ('monday' | 'sunday') to ask for a specific one.
export function weekRange(dateString, weekStart = getSettings().weekStart) {
  const [year, month, day] = dateString.split('-').map(Number)
  const weekday = new Date(year, month - 1, day).getDay() // 0 = Sunday
  const daysSinceStart = weekStart === 'sunday' ? weekday : (weekday + 6) % 7
  const from = addDays(dateString, -daysSinceStart)
  return { from, to: addDays(from, 6) }
}

const DATE_LOCALES = { 'day-first': 'en-GB', 'month-first': 'en-US' }

// "2026-10-25" -> "Sun, 25 Oct 2026". The layout follows the date format chosen in Settings; "Browser default"
// follows the browser's own language.
export function formatDate(dateString) {
  const { dateFormat } = getSettings()
  if (dateFormat === 'iso') return dateString
  const [year, month, day] = dateString.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(DATE_LOCALES[dateFormat], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

// "2026-10-21" -> "Wed 21" (short label for chart axes and calendar headings)
export function formatDayLabel(dateString) {
  const [year, month, day] = dateString.split('-').map(Number)
  return `${new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: 'short' })} ${day}`
}

// "14:30" -> "2:30 PM" (or "14:30"), following the time format chosen in Settings
export function formatTime(timeString) {
  const { timeFormat } = getSettings()
  if (timeFormat === '24h') return timeString
  const [hours, minutes] = timeString.split(':').map(Number)
  const options = { hour: 'numeric', minute: '2-digit', ...(timeFormat === '12h' && { hour12: true }) }
  return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString(timeFormat === '12h' ? 'en-US' : undefined, options)
}

// 90 -> "1 h 30 min"
export function formatMinutes(total) {
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours === 0) return `${minutes} min`
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
}
