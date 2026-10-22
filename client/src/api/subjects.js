import { apiRequest } from './client.js'

export const listSubjects = (signal) => apiRequest('/subjects', { signal })
export const createSubject = (subject) => apiRequest('/subjects', { method: 'POST', body: subject })
export const updateSubject = (id, subject) => apiRequest(`/subjects/${id}`, { method: 'PUT', body: subject })
export const deleteSubject = (id) => apiRequest(`/subjects/${id}`, { method: 'DELETE' })
