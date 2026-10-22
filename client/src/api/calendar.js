import { apiRequest } from './client.js'
import { localNowParam } from '../utils/dates.js'

// Events (assignment due dates, tasks, study sessions) for the days from..to, both included.
// `types` is a list such as ['task', 'session']; `subject` is a subject id or ''.
export function getCalendarEvents({ from, to, types, subject }, signal) {
  const query = new URLSearchParams({ from, to, now: localNowParam() })
  if (types) query.set('types', types.join(','))
  if (subject) query.set('subject', subject)
  return apiRequest(`/calendar?${query}`, { signal })
}
