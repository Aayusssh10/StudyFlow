// Preferences, saved in THIS browser only (localStorage). There are no accounts, so nothing is stored on the server.
// Whatever is read back is validated: a damaged or hand-edited value falls back to the default for that setting.

const STORAGE_KEY = 'studyflow.settings.v1'

export const WEEK_STARTS = [
  { value: 'monday', label: 'Monday' },
  { value: 'sunday', label: 'Sunday' },
]
export const DATE_FORMATS = [
  { value: 'auto', label: 'Browser default' },
  { value: 'day-first', label: 'Day first (Wed, 21 Oct 2026)' },
  { value: 'month-first', label: 'Month first (Wed, Oct 21, 2026)' },
  { value: 'iso', label: 'Year first (2026-10-21)' },
]
export const TIME_FORMATS = [
  { value: 'auto', label: 'Browser default' },
  { value: '12h', label: '12-hour (2:30 PM)' },
  { value: '24h', label: '24-hour (14:30)' },
]

export const DEFAULT_SETTINGS = { weekStart: 'monday', dateFormat: 'auto', timeFormat: 'auto' }

const OPTIONS = { weekStart: WEEK_STARTS, dateFormat: DATE_FORMATS, timeFormat: TIME_FORMATS }

// Keeps only known settings with known values.
export function sanitizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const clean = {}
  for (const [key, options] of Object.entries(OPTIONS)) {
    clean[key] = options.some((option) => option.value === source[key]) ? source[key] : DEFAULT_SETTINGS[key]
  }
  return clean
}

function readStored() {
  try {
    const text = window.localStorage.getItem(STORAGE_KEY)
    return sanitizeSettings(text ? JSON.parse(text) : null)
  } catch {
    return { ...DEFAULT_SETTINGS } // storage blocked, or the stored text is not valid JSON
  }
}

let current = null
const listeners = new Set()
const notify = () => listeners.forEach((listener) => listener())

// Another tab changed the settings: read them again.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      current = null
      notify()
    }
  })
}

// The same object is returned until the settings change (required by useSyncExternalStore).
export function getSettings() {
  if (current === null) current = readStored()
  return current
}

// Saves some settings. Returns true when they were written to the browser's storage; false means they only
// apply until the page is closed (for example when the browser blocks storage).
export function saveSettings(changes) {
  current = sanitizeSettings({ ...getSettings(), ...changes })
  notify()
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
    return true
  } catch {
    return false
  }
}

export function resetSettings() {
  current = { ...DEFAULT_SETTINGS }
  notify()
  try {
    window.localStorage.removeItem(STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

export function subscribeToSettings(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
