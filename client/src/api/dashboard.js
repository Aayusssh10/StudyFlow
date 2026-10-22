import { apiRequest } from './client.js'
import { localNowParam } from '../utils/dates.js'
import { getSettings } from '../utils/settings.js'

// Every figure is calculated by the server from the saved records; the browser only sends its local time
// (so "today", "overdue" and "this week" follow the clock on the user's own computer) and the week-start setting.
export const getDashboardStats = (signal) => {
  const query = new URLSearchParams({ now: localNowParam(), weekStart: getSettings().weekStart })
  return apiRequest(`/dashboard/stats?${query}`, { signal })
}
