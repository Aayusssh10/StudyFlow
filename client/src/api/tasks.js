import { apiList, apiRequest } from './client.js'
import { localNowParam } from '../utils/dates.js'

// Builds "?a=1&b=2" from an object, skipping empty values.
function toQuery(params) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== undefined && value !== null) query.set(key, value)
  }
  return `?${query}`
}

// Every call sends the user's local time so the server can work out overdue / today correctly.
const withNow = (params = {}) => toQuery({ ...params, now: localNowParam() })

export const listTasks = (filters, signal) => apiList(`/tasks${withNow(filters)}`, { signal })
export const getTask = (id, signal) => apiRequest(`/tasks/${encodeURIComponent(id)}${withNow()}`, { signal })
export const createTask = (task) => apiRequest(`/tasks${withNow()}`, { method: 'POST', body: task })
export const updateTask = (id, task) => apiRequest(`/tasks/${id}${withNow()}`, { method: 'PUT', body: task })
export const updateTaskCompleted = (id, completed) => apiRequest(`/tasks/${id}/completed${withNow()}`, { method: 'PATCH', body: { completed } })
export const deleteTask = (id) => apiRequest(`/tasks/${id}`, { method: 'DELETE' })
