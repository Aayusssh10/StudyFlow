import { ApiError, apiRequest } from './client.js'
import { localNowParam } from '../utils/dates.js'
import { getSettings } from '../utils/settings.js'

// The filters every report call shares: { from, to, subject } (empty text = not filtered).
function reportQuery({ from, to, subject }, extra = {}) {
  const query = new URLSearchParams({ now: localNowParam(), weekStart: getSettings().weekStart, ...extra })
  if (from) query.set('from', from)
  if (to) query.set('to', to)
  if (subject) query.set('subject', subject)
  return query
}

export const getReportSummary = (filters, signal) => apiRequest(`/reports/summary?${reportQuery(filters)}`, { signal })

// Downloads a CSV of `type` ('assignments' | 'tasks' | 'study-sessions') for the same filters as the report.
// Returns the file name. A server error (for example a range with too many rows) is thrown as an ApiError.
export async function downloadExport(type, filters) {
  let response
  try {
    response = await fetch(`/api/reports/export?${reportQuery(filters, { type })}`)
  } catch {
    throw new ApiError('Cannot reach the StudyFlow server. Is it running?', 0)
  }

  if (!response.ok) {
    let payload = null
    try {
      payload = await response.json()
    } catch {
      // not JSON: use the generic message below
    }
    throw new ApiError(payload?.error?.message || `The export failed (${response.status}).`, response.status)
  }

  const blob = await response.blob()
  const filename = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? `studyflow-${type}.csv`
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return filename
}
