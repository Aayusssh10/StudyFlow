// Must match the lists in server/src/models/Assignment.js.
export const PRIORITIES = ['Low', 'Medium', 'High']
export const STATUSES = ['Not Started', 'In Progress', 'Completed']
export const TYPES = ['Homework', 'Project', 'Exam', 'Other']

export const TIMING_LABELS = {
  overdue: 'Overdue',
  dueSoon: 'Due soon',
  upcoming: 'Upcoming',
  completed: 'Completed',
}

export const SORT_OPTIONS = [
  { value: 'dueDate', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
  { value: 'createdAt', label: 'Date added' },
]
