import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client.js'
import { SESSION_TYPES } from '../constants/sessions.js'
import Notice from './Notice.jsx'

function toFormValues(session, defaultDate) {
  return {
    subject: session?.subject?.id ?? '',
    assignment: session?.assignment?.id ?? '',
    date: session?.date ?? defaultDate,
    startTime: session?.startTime ?? '',
    durationMinutes: session?.durationMinutes ?? '',
    type: session?.type ?? '',
    notes: session?.notes ?? '',
  }
}

// Used for both "add" and "edit". `onSubmit` must return a promise that rejects on failure.
// `onTargetError` lets the page refresh its lists when the server says a subject/assignment is gone.
export default function SessionForm({ session, defaultDate, subjects, assignments, listsLoaded, listsError, onSubmit, onCancel, onTargetError }) {
  const [values, setValues] = useState(() => toFormValues(session, defaultDate))
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  const change = (field) => (event) => setValues((current) => ({ ...current, [field]: event.target.value }))
  const errorFor = (field) => fieldErrors[field] && <p className="field-error" id={`session-${field}-error`}>{fieldErrors[field]}</p>
  const invalid = (field) => ({
    'aria-invalid': Boolean(fieldErrors[field]),
    'aria-describedby': fieldErrors[field] ? `session-${field}-error` : undefined,
  })

  // If the chosen subject/assignment disappeared (deleted elsewhere) once the lists are up to date, treat it as
  // "not chosen" instead of silently keeping an id that no longer exists.
  const stillThere = (items, id) => !listsLoaded || items.some((item) => item.id === id)
  const subjectValue = stillThere(subjects, values.subject) ? values.subject : ''
  const assignmentValue = stillThere(assignments, values.assignment) ? values.assignment : ''

  // Choosing an assignment is a shortcut: if it belongs to a subject and none is chosen yet, use that subject.
  function chooseAssignment(event) {
    const id = event.target.value
    const chosen = assignments.find((assignment) => assignment.id === id)
    setValues((current) => ({
      ...current,
      assignment: id,
      subject: !subjectValue && chosen?.subject ? chosen.subject.id : current.subject,
    }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setFormError('')

    // Quick checks for the most common mistakes. The server validates everything again.
    const problems = {}
    if (!subjectValue) problems.subject = 'Choose a subject.'
    if (!values.date) problems.date = 'Date is required.'
    const minutes = Number(values.durationMinutes)
    if (values.durationMinutes === '' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      problems.durationMinutes = 'Enter a whole number of minutes from 1 to 1440.'
    }
    setFieldErrors(problems)
    if (Object.keys(problems).length > 0) return

    setSaving(true)
    try {
      await onSubmit({
        subject: subjectValue,
        assignment: assignmentValue || null,
        date: values.date,
        startTime: values.startTime,
        durationMinutes: minutes,
        type: values.type,
        notes: values.notes,
      })
    } catch (error) {
      if (error instanceof ApiError && Array.isArray(error.details)) {
        setFieldErrors(Object.fromEntries(error.details.map((d) => [d.field, d.message])))
        if (error.details.some((d) => d.field === 'subject' || d.field === 'assignment')) onTargetError?.()
      }
      setFormError(error.message)
      setSaving(false)
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit} noValidate aria-labelledby="session-form-title">
      <h2 id="session-form-title">{session ? 'Edit study session' : 'Add a study session'}</h2>
      {formError && <Notice type="error">{formError}</Notice>}

      <div className="form-grid">
        <div className="field">
          <label htmlFor="session-subject">Subject <span className="required" aria-hidden="true">*</span></label>
          <select id="session-subject" value={subjectValue} onChange={change('subject')} required aria-required="true" autoFocus {...invalid('subject')}>
            <option value="">Choose a subject...</option>
            {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
          </select>
          {errorFor('subject')}
          {!listsError && listsLoaded && subjects.length === 0 && (
            <p className="field-hint">No subjects yet. <Link to="/subjects">Add one on the Subjects page</Link> first.</p>
          )}
        </div>

        <div className="field">
          <label htmlFor="session-assignment">Assignment (optional)</label>
          <select id="session-assignment" value={assignmentValue} onChange={chooseAssignment} {...invalid('assignment')}>
            <option value="">No assignment</option>
            {assignments.map((assignment) => (
              <option key={assignment.id} value={assignment.id}>
                {assignment.title}{assignment.subject ? ` (${assignment.subject.name})` : ''}
              </option>
            ))}
          </select>
          {errorFor('assignment')}
        </div>
        {listsError && <p className="field-error field-wide">Could not load subjects or assignments: {listsError}</p>}

        <div className="field">
          <label htmlFor="session-date">Date <span className="required" aria-hidden="true">*</span></label>
          <input id="session-date" type="date" value={values.date} onChange={change('date')} required aria-required="true" {...invalid('date')} />
          {errorFor('date')}
        </div>

        <div className="field">
          <label htmlFor="session-startTime">Start time (optional)</label>
          <input id="session-startTime" type="time" value={values.startTime} onChange={change('startTime')} {...invalid('startTime')} />
          {errorFor('startTime')}
        </div>

        <div className="field">
          <label htmlFor="session-durationMinutes">Duration in minutes <span className="required" aria-hidden="true">*</span></label>
          <input id="session-durationMinutes" type="number" min="1" max="1440" step="1" inputMode="numeric" value={values.durationMinutes} onChange={change('durationMinutes')} required aria-required="true" {...invalid('durationMinutes')} />
          {errorFor('durationMinutes')}
        </div>

        <div className="field">
          <label htmlFor="session-type">Type (optional)</label>
          <select id="session-type" value={values.type} onChange={change('type')} {...invalid('type')}>
            <option value="">No type</option>
            {SESSION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          {errorFor('type')}
        </div>

        <div className="field field-wide">
          <label htmlFor="session-notes">Notes (optional)</label>
          <textarea id="session-notes" rows={3} value={values.notes} onChange={change('notes')} maxLength={1000} {...invalid('notes')} />
          {errorFor('notes')}
        </div>
      </div>

      <div className="form-actions">
        <button type="submit" className="button" disabled={saving}>{saving ? 'Saving...' : session ? 'Save changes' : 'Add session'}</button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </form>
  )
}
