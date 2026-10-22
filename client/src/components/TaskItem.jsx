import { formatDate, formatTime } from '../utils/dates.js'

const TIMING_LABELS = { overdue: 'Overdue', today: 'Today', upcoming: 'Upcoming', completed: 'Done' }

// One task. The checkbox ticks it off; the coloured edge AND the text badge show overdue / today / upcoming / done,
// so the state is never shown by colour alone.
export default function TaskItem({ task, showDate, busy, onToggle, onEdit, onDelete }) {
  const { title, completed, date, time, priority, description, subject, assignment, timing } = task
  // A task linked to an assignment shows that assignment's subject too (read from the assignment).
  const subjectToShow = subject ?? assignment?.subject ?? null

  return (
    <li className={`card task-item timing-${timing}`} data-timing={timing}>
      <label className="task-check">
        <input type="checkbox" checked={completed} disabled={busy} onChange={() => onToggle(task)} />
        <span className="visually-hidden">{completed ? `Mark "${title}" as not done` : `Mark "${title}" as done`}</span>
      </label>

      <div className="task-body">
        <div className="assignment-head">
          <h2 className="assignment-title task-title">{title}</h2>
          <div className="badge-row">
            <span className={`badge badge-task-${timing}`}>{TIMING_LABELS[timing]}</span>
            <span className={`badge badge-priority-${priority.toLowerCase()}`}>{priority} priority</span>
          </div>
        </div>

        <p className="task-when">
          {showDate && <span>{formatDate(date)}</span>}
          {time && <span>{showDate ? ' at ' : ''}{formatTime(time)}</span>}
          {!showDate && !time && <span className="muted">Any time</span>}
        </p>

        {(subjectToShow || assignment) && (
          <p className="task-links">
            {assignment && <span className="task-link-chip">Assignment: {assignment.title}</span>}
            {subjectToShow && (
              <span className="subject-chip" style={{ '--subject-color': subjectToShow.color }}>
                <span className="color-dot" aria-hidden="true" />{subjectToShow.name}
              </span>
            )}
          </p>
        )}

        {description && (
          <details className="assignment-details">
            <summary>Show description</summary>
            <p>{description}</p>
          </details>
        )}

        <div className="card-actions">
          <button type="button" className="button button-secondary" onClick={() => onEdit(task)} disabled={busy}>
            Edit<span className="visually-hidden"> {title}</span>
          </button>
          <button type="button" className="button button-danger-outline" onClick={() => onDelete(task)} disabled={busy}>
            Delete<span className="visually-hidden"> {title}</span>
          </button>
        </div>
      </div>
    </li>
  )
}
