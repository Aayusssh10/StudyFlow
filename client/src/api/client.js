// All calls to the backend go through this file, so error handling lives in one place.
// The server always answers { success, data } or { success: false, error: { message } }.

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }
}

// Sends the request and returns the whole JSON payload ({ success, data, meta? }).
async function request(path, { method = 'GET', body, signal } = {}) {
  let response
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new ApiError('Cannot reach the StudyFlow server. Is it running?', 0)
  }

  let payload = null
  try {
    payload = await response.json()
  } catch {
    // non-JSON response, handled below
  }

  if (!response.ok || !payload?.success) {
    throw new ApiError(payload?.error?.message || `Request failed (${response.status}).`, response.status, payload?.error?.details)
  }
  return payload
}

export async function apiRequest(path, options) {
  return (await request(path, options)).data
}

// For list endpoints: returns { data, meta } so pages can show totals and paging.
export async function apiList(path, options) {
  const { data, meta } = await request(path, options)
  return { data, meta }
}

export const getHealth = (signal) => apiRequest('/health', { signal })
