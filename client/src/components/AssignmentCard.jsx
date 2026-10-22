import { TIMING_LABELS } from '../constants/assignments.js'
import { formatDate, formatMinutes, formatTime } from '../utils/dates.js'

// One assignment. The coloured edge AND the text badge show overdue / due soon / upcoming / completed,
// so the state is never shown by colour alone.
export default function AssignmentCard({ assignment, busy, onEdit, onDelete, onToggleComplete }) {
  const { title, subject, dueDate, dueTime, priority, status, type, estimatedMinutes, description, timing } = assignment
  const isCompleted = status === 'Completed'

  return (
    <li className={`card assignment-card timing-${timing}`} data-timing={timing}>
      <div className="assignment-head">
        <h2 className="assignment-title">{title}</h2>
        <div className="badge-row">
          <span className={`badge badge-timing-${timing}`}>{TIMING_LABELS[timing]}</span>
          <span className={`badge badge-priority-${priority.toLowerCase()}`}>{priority} priority</span>
          {!isCompleted && <span className="badge badge-neutral">{status}</span>}
        </div>
      </div>

      <dl className="assignment-meta">
        <div>
          <dt>Subject</dt>
          <dd>
            {subject ? (
              <span className="subject-chip" style={{ '--subject-color': subject.color }}>
                <span className="color-dot" aria-hidden="true" />{subject.name}
              </span>
            ) : (
              <span className="muted">No subject</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Due</dt>
          <dd>{formatDate(dueDate)}{dueTime && ` at ${formatTime(dueTime)}`}</dd>
        </div>
        {type && (
          <div>
            <dt>Type</dt>
            <dd>{type}</dd>
          </div>
        )}
        {estimatedMinutes && (
          <div>
            <dt>Estimate</dt>
            <dd>{formatMinutes(estimatedMinutes)}</dd>
          </div>
        )}
      </dl>

      {description && (
        <details className="assignment-details">
          <summary>Show description</summary>
          <p>{description}</p>
        </details>
      )}

      <div className="card-actions">
        <button type="button" className="button button-secondary" onClick={() => onToggleComplete(assignment)} disabled={busy}>
          {isCompleted ? 'Reopen' : 'Mark complete'}<span className="visually-hidden">: {title}</span>
        </button>
        <button type="button" className="button button-secondary" onClick={() => onEdit(assignment)} disabled={busy}>
          Edit<span className="visually-hidden"> {title}</span>
        </button>
        <button type="button" className="button button-danger-outline" onClick={() => onDelete(assignment)} disabled={busy}>
          Delete<span className="visually-hidden"> {title}</span>
        </button>
      </div>
    </li>
  )
}
