import { useState } from 'react'
import { ApiError } from '../api/client.js'
import Notice from './Notice.jsx'

const DEFAULT_COLOR = '#4f46e5'

function toFormValues(subject) {
  return {
    name: subject?.name ?? '',
    code: subject?.code ?? '',
    instructor: subject?.instructor ?? '',
    description: subject?.description ?? '',
    color: subject?.color ?? DEFAULT_COLOR,
  }
}

// Used for both "add" and "edit". `onSubmit` must return a promise that rejects on failure.
export default function SubjectForm({ subject, onSubmit, onCancel }) {
  const [values, setValues] = useState(() => toFormValues(subject))
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  const change = (field) => (event) => setValues((current) => ({ ...current, [field]: event.target.value }))

  async function handleSubmit(event) {
    event.preventDefault()
    setFormError('')

    // Quick check for the most common mistake. The server validates everything again.
    if (!values.name.trim()) {
      setFieldErrors({ name: 'Subject name is required.' })
      return
    }
    setFieldErrors({})
    setSaving(true)
    try {
      await onSubmit(values)
    } catch (error) {
      if (error instanceof ApiError && Array.isArray(error.details)) {
        setFieldErrors(Object.fromEntries(error.details.map((d) => [d.field, d.message])))
      }
      setFormError(error.message)
      setSaving(false)
    }
  }

  const heading = subject ? 'Edit subject' : 'Add a subject'

  return (
    <form className="card form" onSubmit={handleSubmit} noValidate aria-labelledby="subject-form-title">
      <h2 id="subject-form-title">{heading}</h2>
      {formError && <Notice type="error">{formError}</Notice>}

      <div className="form-grid">
        <div className="field">
          <label htmlFor="subject-name">Name <span className="required" aria-hidden="true">*</span></label>
          <input
            id="subject-name"
            value={values.name}
            onChange={change('name')}
            maxLength={100}
            required
            aria-required="true"
            aria-invalid={Boolean(fieldErrors.name)}
            aria-describedby={fieldErrors.name ? 'subject-name-error' : undefined}
            autoFocus
          />
          {fieldErrors.name && <p className="field-error" id="subject-name-error">{fieldErrors.name}</p>}
        </div>

        <div className="field">
          <label htmlFor="subject-code">Code (optional)</label>
          <input id="subject-code" value={values.code} onChange={change('code')} maxLength={20} placeholder="e.g. MATH101" />
          {fieldErrors.code && <p className="field-error">{fieldErrors.code}</p>}
        </div>

        <div className="field">
          <label htmlFor="subject-instructor">Instructor (optional)</label>
          <input id="subject-instructor" value={values.instructor} onChange={change('instructor')} maxLength={100} />
          {fieldErrors.instructor && <p className="field-error">{fieldErrors.instructor}</p>}
        </div>

        <div className="field">
          <label htmlFor="subject-color">Color</label>
          <input id="subject-color" type="color" value={values.color} onChange={change('color')} className="color-input" />
          {fieldErrors.color && <p className="field-error">{fieldErrors.color}</p>}
        </div>

        <div className="field field-wide">
          <label htmlFor="subject-description">Description (optional)</label>
          <textarea id="subject-description" rows={3} value={values.description} onChange={change('description')} maxLength={500} />
          {fieldErrors.description && <p className="field-error">{fieldErrors.description}</p>}
        </div>
      </div>

      <div className="form-actions">
        <button type="submit" className="button" disabled={saving}>
          {saving ? 'Saving...' : subject ? 'Save changes' : 'Add subject'}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  )
}
