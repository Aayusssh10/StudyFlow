import { apiList, apiRequest } from './client.js'

// Builds "?a=1&b=2" from an object, skipping empty values.
function toQuery(params) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== undefined && value !== null) query.set(key, value)
  }
  const text = query.toString()
  return text ? `?${text}` : ''
}

export const listStudySessions = (filters, signal) => apiList(`/study-sessions${toQuery(filters)}`, { signal })
// Study-time totals calculated by the server from the stored sessions that match the filters.
export const getStudySummary = (filters, signal) => apiRequest(`/study-sessions/summary${toQuery(filters)}`, { signal })
export const getStudySession = (id, signal) => apiRequest(`/study-sessions/${encodeURIComponent(id)}`, { signal })
export const createStudySession = (session) => apiRequest('/study-sessions', { method: 'POST', body: session })
export const updateStudySession = (id, session) => apiRequest(`/study-sessions/${id}`, { method: 'PUT', body: session })
export const deleteStudySession = (id) => apiRequest(`/study-sessions/${id}`, { method: 'DELETE' })
