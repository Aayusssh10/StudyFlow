import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client.js'
import { PRIORITIES, STATUSES, TYPES } from '../constants/assignments.js'
import Notice from './Notice.jsx'

function toFormValues(assignment) {
  return {
    title: assignment?.title ?? '',
    subject: assignment?.subject?.id ?? '',
    dueDate: assignment?.dueDate ?? '',
    dueTime: assignment?.dueTime ?? '',
    priority: assignment?.priority ?? 'Medium',
    status: assignment?.status ?? 'Not Started',
    type: assignment?.type ?? '',
    estimatedMinutes: assignment?.estimatedMinutes ?? '',
    description: assignment?.description ?? '',
  }
}

// Used for both "add" and "edit". `onSubmit` must return a promise that rejects on failure.
// `onSubjectError` lets the page refresh its subject list when the server says a subject is gone.
export default function AssignmentForm({ assignment, subjects, subjectsLoaded, subjectsError, onSubmit, onCancel, onSubjectError }) {
  const [values, setValues] = useState(() => toFormValues(assignment))
  // If the chosen subject disappeared (deleted elsewhere) once the list is up to date, fall back to
  // "No subject" instead of silently keeping an id that no longer exists.
  const subjectValue = subjectsLoaded && !subjects.some((subject) => subject.id === values.subject) ? '' : values.subject
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  const change = (field) => (event) => setValues((current) => ({ ...current, [field]: event.target.value }))
  const errorFor = (field) => fieldErrors[field] && <p className="field-error" id={`assignment-${field}-error`}>{fieldErrors[field]}</p>
  const invalid = (field) => ({
    'aria-invalid': Boolean(fieldErrors[field]),
    'aria-describedby': fieldErrors[field] ? `assignment-${field}-error` : undefined,
  })

  async function handleSubmit(event) {
    event.preventDefault()
    setFormError('')

    // Quick checks for the most common mistakes. The server validates everything again.
    const problems = {}
    if (!values.title.trim()) problems.title = 'Title is required.'
    if (!values.dueDate) problems.dueDate = 'Due date is required.'
    setFieldErrors(problems)
    if (Object.keys(problems).length > 0) return

    setSaving(true)
    try {
      await onSubmit({
        ...values,
        estimatedMinutes: values.estimatedMinutes === '' ? null : Number(values.estimatedMinutes),
        subject: subjectValue || null,
      })
    } catch (error) {
      if (error instanceof ApiError && Array.isArray(error.details)) {
        setFieldErrors(Object.fromEntries(error.details.map((d) => [d.field, d.message])))
        if (error.details.some((d) => d.field === 'subject')) onSubjectError?.()
      }
      setFormError(error.message)
      setSaving(false)
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit} noValidate aria-labelledby="assignment-form-title">
      <h2 id="assignment-form-title">{assignment ? 'Edit assignment' : 'Add an assignment'}</h2>
      {formError && <Notice type="error">{formError}</Notice>}

      <div className="form-grid">
        <div className="field field-wide">
          <label htmlFor="assignment-title">Title <span className="required" aria-hidden="true">*</span></label>
          <input id="assignment-title" value={values.title} onChange={change('title')} maxLength={150} required aria-required="true" autoFocus {...invalid('title')} />
          {errorFor('title')}
        </div>

        <div className="field">
          <label htmlFor="assignment-subject">Subject (optional)</label>
          <select id="assignment-subject" value={subjectValue} onChange={change('subject')} {...invalid('subject')}>
            <option value="">No subject</option>
            {subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>{subject.name}</option>
            ))}
          </select>
          {errorFor('subject')}
          {subjectsError && <p className="field-error">Could not load subjects: {subjectsError}</p>}
          {!subjectsError && subjects.length === 0 && (
            <p className="field-hint">No subjects yet. <Link to="/subjects">Add one on the Subjects page</Link>, or leave this empty.</p>
          )}
        </div>

        <div className="field">
          <label htmlFor="assignment-type">Type (optional)</label>
          <select id="assignment-type" value={values.type} onChange={change('type')} {...invalid('type')}>
            <option value="">No type</option>
            {TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          {errorFor('type')}
        </div>

        <div className="field">
          <label htmlFor="assignment-dueDate">Due date <span className="required" aria-hidden="true">*</span></label>
          <input id="assignment-dueDate" type="date" value={values.dueDate} onChange={change('dueDate')} required aria-required="true" {...invalid('dueDate')} />
          {errorFor('dueDate')}
        </div>

        <div className="field">
          <label htmlFor="assignment-dueTime">Due time (optional)</label>
          <input id="assignment-dueTime" type="time" value={values.dueTime} onChange={change('dueTime')} {...invalid('dueTime')} />
          {errorFor('dueTime')}
        </div>

        <div className="field">
          <label htmlFor="assignment-priority">Priority</label>
          <select id="assignment-priority" value={values.priority} onChange={change('priority')} {...invalid('priority')}>
            {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
          </select>
          {errorFor('priority')}
        </div>

        <div className="field">
          <label htmlFor="assignment-status">Status</label>
          <select id="assignment-status" value={values.status} onChange={change('status')} {...invalid('status')}>
            {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
          {errorFor('status')}
        </div>

        <div className="field">
          <label htmlFor="assignment-estimatedMinutes">Estimated minutes (optional)</label>
          <input id="assignment-estimatedMinutes" type="number" min="1" max="10080" step="1" inputMode="numeric" value={values.estimatedMinutes} onChange={change('estimatedMinutes')} {...invalid('estimatedMinutes')} />
          {errorFor('estimatedMinutes')}
        </div>

        <div className="field field-wide">
          <label htmlFor="assignment-description">Description (optional)</label>
          <textarea id="assignment-description" rows={3} value={values.description} onChange={change('description')} maxLength={2000} {...invalid('description')} />
          {errorFor('description')}
        </div>
      </div>

      <div className="form-actions">
        <button type="submit" className="button" disabled={saving}>
          {saving ? 'Saving...' : assignment ? 'Save changes' : 'Add assignment'}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </form>
  )
}
