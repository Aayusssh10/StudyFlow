import { formatDate, formatMinutes, formatTime } from '../utils/dates.js'

// One recorded (or planned) study session.
export default function SessionItem({ session, onEdit, onDelete }) {
  const { subject, assignment, date, startTime, durationMinutes, type, notes } = session
  const label = `${subject?.name ?? 'session'} on ${formatDate(date)}`

  return (
    <li className="card session-item" style={{ '--subject-color': subject?.color }}>
      <div className="session-duration">
        <strong>{formatMinutes(durationMinutes)}</strong>
      </div>

      <div className="session-body">
        <div className="assignment-head">
          <h2 className="assignment-title task-title">
            <span className="subject-chip">
              <span className="color-dot" aria-hidden="true" />{subject?.name ?? 'Unknown subject'}
            </span>
          </h2>
          {type && <span className="badge badge-neutral">{type}</span>}
        </div>

        <p className="task-when">
          {formatDate(date)}{startTime && ` at ${formatTime(startTime)}`}
        </p>

        {assignment && <p className="task-links"><span className="task-link-chip">For assignment: {assignment.title}</span></p>}

        {notes && (
          <details className="assignment-details">
            <summary>Show notes</summary>
            <p>{notes}</p>
          </details>
        )}

        <div className="card-actions">
          <button type="button" className="button button-secondary" onClick={() => onEdit(session)}>
            Edit<span className="visually-hidden"> session for {label}</span>
          </button>
          <button type="button" className="button button-danger-outline" onClick={() => onDelete(session)}>
            Delete<span className="visually-hidden"> session for {label}</span>
          </button>
        </div>
      </div>
    </li>
  )
}
