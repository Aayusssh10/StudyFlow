import { useEffect, useState } from 'react'
import { createSubject, deleteSubject, listSubjects, updateSubject } from '../api/subjects.js'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import Notice from '../components/Notice.jsx'
import PageHeader from '../components/PageHeader.jsx'
import SubjectForm from '../components/SubjectForm.jsx'

export default function Subjects() {
  const [subjects, setSubjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState(null) // { type, text }
  const [formMode, setFormMode] = useState(null) // null | 'create' | a subject being edited
  const [subjectToDelete, setSubjectToDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const [reloadCount, setReloadCount] = useState(0) // bump to fetch the list again
  const reloadSubjects = () => setReloadCount((count) => count + 1)

  useEffect(() => {
    const controller = new AbortController()
    listSubjects(controller.signal)
      .then((data) => {
        setSubjects(data)
        setLoadError('')
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setLoadError(error.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [reloadCount])

  async function handleSave(values) {
    const isEditing = formMode !== 'create'
    if (isEditing) await updateSubject(formMode.id, values)
    else await createSubject(values)

    setNotice({ type: 'success', text: isEditing ? 'Subject updated.' : 'Subject added.' })
    setFormMode(null)
    reloadSubjects()
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await deleteSubject(subjectToDelete.id)
      setNotice({ type: 'success', text: `Deleted "${subjectToDelete.name}".` })
      reloadSubjects()
    } catch (error) {
      // e.g. 409: the subject is still used by assignments. The server explains why.
      setNotice({ type: 'error', text: error.message })
    } finally {
      setDeleting(false)
      setSubjectToDelete(null)
    }
  }

  return (
    <>
      <PageHeader title="Subjects" subtitle="Organize your courses.">
        {!formMode && (
          <button type="button" className="button" onClick={() => { setNotice(null); setFormMode('create') }}>
            Add subject
          </button>
        )}
      </PageHeader>

      {notice && <Notice type={notice.type} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

      {formMode && (
        <SubjectForm
          key={formMode === 'create' ? 'create' : formMode.id}
          subject={formMode === 'create' ? null : formMode}
          onSubmit={handleSave}
          onCancel={() => setFormMode(null)}
        />
      )}

      {loading && <p className="muted" role="status">Loading subjects...</p>}

      {loadError && (
        <Notice type="error">
          {loadError}{' '}
          <button type="button" className="link-button" onClick={() => { setLoading(true); reloadSubjects() }}>Try again</button>
        </Notice>
      )}

      {!loading && !loadError && subjects.length === 0 && !formMode && (
        <section className="card empty-state">
          <h2>No subjects yet</h2>
          <p>Add your first subject, such as "Mathematics", to start organizing assignments and study time.</p>
          <button type="button" className="button" onClick={() => setFormMode('create')}>Add your first subject</button>
        </section>
      )}

      {subjects.length > 0 && (
        <ul className="subject-grid" aria-label="Your subjects">
          {subjects.map((subject) => (
            <li key={subject.id} className="card subject-card" style={{ '--subject-color': subject.color }}>
              <div className="subject-title">
                <span className="color-dot" aria-hidden="true" />
                <h2>{subject.name}</h2>
              </div>
              {subject.code && <span className="badge badge-neutral">{subject.code}</span>}
              {subject.instructor && <p className="muted">Instructor: {subject.instructor}</p>}
              {subject.description && <p>{subject.description}</p>}
              <div className="card-actions">
                <button type="button" className="button button-secondary" onClick={() => { setNotice(null); setFormMode(subject) }}>
                  Edit<span className="visually-hidden"> {subject.name}</span>
                </button>
                <button type="button" className="button button-danger-outline" onClick={() => setSubjectToDelete(subject)}>
                  Delete<span className="visually-hidden"> {subject.name}</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={Boolean(subjectToDelete)}
        title={`Delete "${subjectToDelete?.name ?? ''}"?`}
        message="This cannot be undone. A subject that still has assignments, tasks or study sessions cannot be deleted."
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setSubjectToDelete(null)}
      />
    </>
  )
}
