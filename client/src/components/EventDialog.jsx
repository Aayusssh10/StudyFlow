import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { TIMING_LABELS } from '../constants/assignments.js'
import { eventLabel } from '../utils/calendar.js'
import { formatDate, formatMinutes, formatTime } from '../utils/dates.js'

const KIND_NAMES = { assignment: 'Assignment deadline', task: 'Task', session: 'Study session' }
const PAGES = { assignment: ['/assignments', 'Assignments'], task: ['/tasks', 'Tasks'], session: ['/study-sessions', 'Study sessions'] }
const TASK_TIMING_LABELS = { overdue: 'Overdue', today: 'Today', upcoming: 'Upcoming', completed: 'Done' }

function Row({ label, children }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

// Details of one calendar event, in the browser's built-in <dialog> (focus stays inside, Esc closes).
export default function EventDialog({ event, onClose }) {
  const dialogRef = useRef(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (event && !dialog.open) dialog.showModal()
    if (!event && dialog.open) dialog.close()
  }, [event])

  const [page, pageName] = event ? PAGES[event.type] : []

  return (
    <dialog ref={dialogRef} className="dialog event-dialog" aria-labelledby="event-dialog-title" onCancel={onClose} onClose={onClose}>
      {event && (
        <>
          <p className="event-kind">{KIND_NAMES[event.type]}{event.type === 'session' && ` - ${event.state}`}</p>
          <h2 id="event-dialog-title">{event.type === 'session' ? eventLabel(event) : event.title}</h2>
          <dl className="event-details">
            <Row label="Date">{formatDate(event.date)}</Row>
            {event.time && <Row label={event.type === 'assignment' ? 'Due time' : 'Time'}>{formatTime(event.time)}</Row>}
            <Row label="Subject">
              {event.subject ? (
                <span className="subject-chip" style={{ '--subject-color': event.subject.color }}>
                  <span className="color-dot" aria-hidden="true" />{event.subject.name}
                </span>
              ) : (
                <span className="muted">{event.type === 'session' ? 'Unknown subject' : 'No subject'}</span>
              )}
            </Row>
            {event.type === 'assignment' && (
              <>
                <Row label="Status">{event.status}</Row>
                <Row label="Priority">{event.priority}</Row>
                <Row label="Timing">{TIMING_LABELS[event.timing]}</Row>
              </>
            )}
            {event.type === 'task' && (
              <>
                <Row label="Done">{event.completed ? 'Yes' : 'No'}</Row>
                <Row label="Priority">{event.priority}</Row>
                <Row label="Timing">{TASK_TIMING_LABELS[event.timing]}</Row>
              </>
            )}
            {event.type === 'session' && (
              <>
                <Row label="Duration">{formatMinutes(event.durationMinutes)}</Row>
                {event.sessionType && <Row label="Type">{event.sessionType}</Row>}
              </>
            )}
            {event.assignmentTitle && <Row label="Assignment">{event.assignmentTitle}</Row>}
          </dl>
          <div className="dialog-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>Close</button>
            <Link className="button" to={`${page}?edit=${event.id}`}>Open in {pageName}</Link>
          </div>
        </>
      )}
    </dialog>
  )
}
