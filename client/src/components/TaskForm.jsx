import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client.js'
import { PRIORITIES } from '../constants/assignments.js'
import Notice from './Notice.jsx'

// A task links to a subject OR an assignment (or neither). This single "Link to" choice makes it impossible
// to pick both, and the server enforces the same rule.
const LINK_NONE = ''
const LINK_SUBJECT = 'subject'
const LINK_ASSIGNMENT = 'assignment'

function toFormValues(task, defaultDate) {
  return {
    title: task?.title ?? '',
    date: task?.date ?? defaultDate,
    time: task?.time ?? '',
    priority: task?.priority ?? 'Medium',
    description: task?.description ?? '',
    linkType: task?.subject ? LINK_SUBJECT : task?.assignment ? LINK_ASSIGNMENT : LINK_NONE,
    subjectId: task?.subject?.id ?? '',
    assignmentId: task?.assignment?.id ?? '',
  }
}

// Used for both "add" and "edit". `onSubmit` must return a promise that rejects on failure.
// `onTargetError` lets the page refresh its lists when the server says a subject/assignment is gone.
export default function TaskForm({ task, defaultDate, subjects, assignments, listsLoaded, listsError, onSubmit, onCancel, onTargetError }) {
  const [values, setValues] = useState(() => toFormValues(task, defaultDate))
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  const change = (field) => (event) => setValues((current) => ({ ...current, [field]: event.target.value }))
  const errorFor = (field) => fieldErrors[field] && <p className="field-error" id={`task-${field}-error`}>{fieldErrors[field]}</p>
  const invalid = (field) => ({
    'aria-invalid': Boolean(fieldErrors[field]),
    'aria-describedby': fieldErrors[field] ? `task-${field}-error` : undefined,
  })

  // If the chosen subject/assignment disappeared (deleted elsewhere) once the lists are up to date, treat it as
  // "not chosen yet" instead of silently keeping an id that no longer exists.
  const stillThere = (items, id) => !listsLoaded || items.some((item) => item.id === id)
  const subjectValue = stillThere(subjects, values.subjectId) ? values.subjectId : ''
  const assignmentValue = stillThere(assignments, values.assignmentId) ? values.assignmentId : ''

  async function handleSubmit(event) {
    event.preventDefault()
    setFormError('')

    // Quick checks for the most common mistakes. The server validates everything again.
    const problems = {}
    if (!values.title.trim()) problems.title = 'Title is required.'
    if (!values.date) problems.date = 'Date is required.'
    if (values.linkType === LINK_SUBJECT && !subjectValue) problems.subject = 'Choose a subject, or change "Link to" to Nothing.'
    if (values.linkType === LINK_ASSIGNMENT && !assignmentValue) problems.assignment = 'Choose an assignment, or change "Link to" to Nothing.'
    setFieldErrors(problems)
    if (Object.keys(problems).length > 0) return

    setSaving(true)
    try {
      await onSubmit({
        title: values.title,
        date: values.date,
        time: values.time,
        priority: values.priority,
        description: values.description,
        subject: values.linkType === LINK_SUBJECT ? subjectValue : null,
        assignment: values.linkType === LINK_ASSIGNMENT ? assignmentValue : null,
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
    <form className="card form" onSubmit={handleSubmit} noValidate aria-labelledby="task-form-title">
      <h2 id="task-form-title">{task ? 'Edit task' : 'Add a task'}</h2>
      {formError && <Notice type="error">{formError}</Notice>}

      <div className="form-grid">
        <div className="field field-wide">
          <label htmlFor="task-title">Title <span className="required" aria-hidden="true">*</span></label>
          <input id="task-title" value={values.title} onChange={change('title')} maxLength={150} required aria-required="true" autoFocus {...invalid('title')} />
          {errorFor('title')}
        </div>

        <div className="field">
          <label htmlFor="task-date">Date <span className="required" aria-hidden="true">*</span></label>
          <input id="task-date" type="date" value={values.date} onChange={change('date')} required aria-required="true" {...invalid('date')} />
          {errorFor('date')}
        </div>

        <div className="field">
          <label htmlFor="task-time">Time (optional)</label>
          <input id="task-time" type="time" value={values.time} onChange={change('time')} {...invalid('time')} />
          {errorFor('time')}
        </div>

        <div className="field">
          <label htmlFor="task-priority">Priority</label>
          <select id="task-priority" value={values.priority} onChange={change('priority')} {...invalid('priority')}>
            {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
          </select>
          {errorFor('priority')}
        </div>

        <div className="field">
          <label htmlFor="task-linkType">Link to</label>
          <select id="task-linkType" value={values.linkType} onChange={change('linkType')}>
            <option value={LINK_NONE}>Nothing</option>
            <option value={LINK_SUBJECT}>A subject</option>
            <option value={LINK_ASSIGNMENT}>An assignment</option>
          </select>
        </div>

        {values.linkType === LINK_SUBJECT && (
          <div className="field field-wide">
            <label htmlFor="task-subject">Subject</label>
            <select id="task-subject" value={subjectValue} onChange={change('subjectId')} {...invalid('subject')}>
              <option value="">Choose a subject...</option>
              {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
            </select>
            {errorFor('subject')}
            {!listsError && listsLoaded && subjects.length === 0 && (
              <p className="field-hint">No subjects yet. <Link to="/subjects">Add one on the Subjects page</Link>.</p>
            )}
          </div>
        )}

        {values.linkType === LINK_ASSIGNMENT && (
          <div className="field field-wide">
            <label htmlFor="task-assignment">Assignment</label>
            <select id="task-assignment" value={assignmentValue} onChange={change('assignmentId')} {...invalid('assignment')}>
              <option value="">Choose an assignment...</option>
              {assignments.map((assignment) => (
                <option key={assignment.id} value={assignment.id}>
                  {assignment.title}{assignment.subject ? ` (${assignment.subject.name})` : ''}
                </option>
              ))}
            </select>
            {errorFor('assignment')}
            {!listsError && listsLoaded && assignments.length === 0 && (
              <p className="field-hint">No assignments yet. <Link to="/assignments">Add one on the Assignments page</Link>.</p>
            )}
          </div>
        )}
        {listsError && <p className="field-error field-wide">Could not load subjects or assignments: {listsError}</p>}

        <div className="field field-wide">
          <label htmlFor="task-description">Description (optional)</label>
          <textarea id="task-description" rows={3} value={values.description} onChange={change('description')} maxLength={1000} {...invalid('description')} />
          {errorFor('description')}
        </div>
      </div>

      <div className="form-actions">
        <button type="submit" className="button" disabled={saving}>{saving ? 'Saving...' : task ? 'Save changes' : 'Add task'}</button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </form>
  )
}
