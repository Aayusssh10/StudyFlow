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

// Every call sends the user's local time so the server can work out overdue / due soon correctly.
const withNow = (params = {}) => toQuery({ ...params, now: localNowParam() })

export const listAssignments = (filters, signal) => apiList(`/assignments${withNow(filters)}`, { signal })
export const getAssignment = (id, signal) => apiRequest(`/assignments/${encodeURIComponent(id)}${withNow()}`, { signal })
export const createAssignment = (assignment) => apiRequest(`/assignments${withNow()}`, { method: 'POST', body: assignment })
export const updateAssignment = (id, assignment) => apiRequest(`/assignments/${id}${withNow()}`, { method: 'PUT', body: assignment })
export const updateAssignmentStatus = (id, status) => apiRequest(`/assignments/${id}/status${withNow()}`, { method: 'PATCH', body: { status } })
export const deleteAssignment = (id) => apiRequest(`/assignments/${id}`, { method: 'DELETE' })
