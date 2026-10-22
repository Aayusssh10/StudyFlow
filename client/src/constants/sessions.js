// Must match the list in server/src/models/StudySession.js.
export const SESSION_TYPES = ['Reading', 'Practice', 'Revision', 'Group study', 'Other']

export const SESSION_SORTS = [
  { value: 'date', label: 'Date' },
  { value: 'duration', label: 'Duration' },
  { value: 'createdAt', label: 'Date added' },
]
