import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  createAssignment,
  deleteAssignment,
  getAssignment,
  listAssignments,
  updateAssignment,
  updateAssignmentStatus,
} from '../api/assignments.js'
import { listSubjects } from '../api/subjects.js'
import AssignmentCard from '../components/AssignmentCard.jsx'
import AssignmentFilters from '../components/AssignmentFilters.jsx'
import AssignmentForm from '../components/AssignmentForm.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import Notice from '../components/Notice.jsx'
import PageHeader from '../components/PageHeader.jsx'
import { STATUSES, TIMING_LABELS } from '../constants/assignments.js'
import useEditLink from '../hooks/useEditLink.js'

const PAGE_SIZE = 20
const NO_FILTERS = { subject: '', status: '', priority: '', timing: '', dueFrom: '', dueTo: '' }
const DEFAULT_FILTERS = { ...NO_FILTERS, sort: 'dueDate', order: '', page: 1 }

// Links from the dashboard open this page already filtered, e.g. /assignments?timing=overdue. Unknown values are ignored.
const startingFilters = (params) => ({
  ...DEFAULT_FILTERS,
  timing: Object.keys(TIMING_LABELS).includes(params.get('timing')) ? params.get('timing') : '',
  status: STATUSES.includes(params.get('status')) ? params.get('status') : '',
})

export default function Assignments() {
  const [searchParams] = useSearchParams()
  const [filters, setFilters] = useState(() => startingFilters(searchParams))
  const [searchText, setSearchText] = useState('')
  const [search, setSearch] = useState('') // the search text after a short pause in typing
  const [reloadCount, setReloadCount] = useState(0) // bump to fetch the list again
  const [result, setResult] = useState({ key: null, data: [], meta: null, error: '' })
  const [subjectState, setSubjectState] = useState({ subjects: [], loaded: false, error: '' })
  const [subjectReloadCount, setSubjectReloadCount] = useState(0)
  const [notice, setNotice] = useState(null) // { type, text }
  const [formMode, setFormMode] = useState(null) // null | 'create' | an assignment being edited
  const [toDelete, setToDelete] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const reload = () => setReloadCount((count) => count + 1)

  // /assignments?edit=<id> (from the calendar) opens that assignment's edit form.
  useEditLink({
    load: getAssignment,
    onFound: setFormMode,
    onError: (error) => setNotice({ type: 'error', text: error.status === 404 || error.status === 400 ? 'That assignment could not be found. It may have been deleted.' : error.message }),
  })

  // Wait 300 ms after the last keystroke before searching, so we do not send a request per letter.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText.trim())
      setFilters((current) => (current.page === 1 ? current : { ...current, page: 1 }))
    }, 300)
    return () => clearTimeout(timer)
  }, [searchText])

  const params = useMemo(() => ({ ...filters, q: search, limit: PAGE_SIZE }), [filters, search])
  const requestKey = JSON.stringify([params, reloadCount])
  const loading = result.key !== requestKey

  useEffect(() => {
    const controller = new AbortController()
    const key = requestKey
    listAssignments(params, controller.signal)
      .then(({ data, meta }) => setResult({ key, data, meta, error: '' }))
      .catch((error) => {
        if (error.name !== 'AbortError') setResult({ key, data: [], meta: null, error: error.message })
      })
    return () => controller.abort()
  }, [params, requestKey])

  // Subjects feed the filter and the form's drop-down.
  useEffect(() => {
    const controller = new AbortController()
    listSubjects(controller.signal)
      .then((subjects) => setSubjectState({ subjects, loaded: true, error: '' }))
      .catch((error) => {
        if (error.name !== 'AbortError') setSubjectState((current) => ({ ...current, error: error.message }))
      })
    return () => controller.abort()
  }, [subjectReloadCount])

  const hasFilters = Object.keys(NO_FILTERS).some((key) => filters[key] !== '') || search !== ''
  const changeFilters = (changes) => setFilters((current) => ({ ...current, ...changes, page: 1 }))
  const clearFilters = () => {
    setFilters((current) => ({ ...DEFAULT_FILTERS, sort: current.sort, order: current.order }))
    setSearchText('')
    setSearch('')
  }

  async function handleSave(values) {
    const isEditing = formMode !== 'create'
    if (isEditing) await updateAssignment(formMode.id, values)
    else await createAssignment(values)

    setNotice({ type: 'success', text: isEditing ? 'Assignment updated.' : 'Assignment added.' })
    setFormMode(null)
    reload()
  }

  async function handleToggleComplete(assignment) {
    const nextStatus = assignment.status === 'Completed' ? 'Not Started' : 'Completed'
    setBusyId(assignment.id)
    try {
      await updateAssignmentStatus(assignment.id, nextStatus)
      setNotice({ type: 'success', text: nextStatus === 'Completed' ? `Marked "${assignment.title}" as complete.` : `Reopened "${assignment.title}".` })
      reload()
    } catch (error) {
      setNotice({ type: 'error', text: error.message })
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await deleteAssignment(toDelete.id)
      setNotice({ type: 'success', text: `Deleted "${toDelete.title}".` })
      // Deleting the last item of a later page: step back one page.
      if (result.data.length === 1 && filters.page > 1) setFilters((current) => ({ ...current, page: current.page - 1 }))
      reload()
    } catch (error) {
      setNotice({ type: 'error', text: error.message })
    } finally {
      setDeleting(false)
      setToDelete(null)
    }
  }

  const { data: assignments, meta, error: loadError } = result
  const totalPages = meta ? Math.max(1, Math.ceil(meta.total / meta.limit)) : 1

  return (
    <>
      <PageHeader title="Assignments" subtitle="Track homework, projects and exams.">
        {!formMode && (
          <button type="button" className="button" onClick={() => { setNotice(null); setFormMode('create') }}>
            Add assignment
          </button>
        )}
      </PageHeader>

      {notice && <Notice type={notice.type} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

      {formMode && (
        <AssignmentForm
          key={formMode === 'create' ? 'create' : formMode.id}
          assignment={formMode === 'create' ? null : formMode}
          subjects={subjectState.subjects}
          subjectsLoaded={subjectState.loaded}
          subjectsError={subjectState.error}
          onSubmit={handleSave}
          onCancel={() => setFormMode(null)}
          onSubjectError={() => setSubjectReloadCount((count) => count + 1)}
        />
      )}

      <AssignmentFilters
        filters={filters}
        searchText={searchText}
        onSearchText={setSearchText}
        onChange={changeFilters}
        onClear={clearFilters}
        subjects={subjectState.subjects}
        hasFilters={hasFilters}
      />

      {loading && <p className="muted" role="status">Loading assignments...</p>}

      {!loading && loadError && (
        <Notice type="error">
          {loadError}{' '}
          <button type="button" className="link-button" onClick={reload}>Try again</button>
        </Notice>
      )}

      {!loading && !loadError && assignments.length === 0 && (
        <section className="card empty-state">
          {hasFilters ? (
            <>
              <h2>No assignments match your filters</h2>
              <p>Try a different search or clear the filters to see everything.</p>
              <button type="button" className="button" onClick={clearFilters}>Clear filters</button>
            </>
          ) : (
            <>
              <h2>No assignments yet</h2>
              <p>Add your first assignment to start tracking deadlines.</p>
              {!formMode && <button type="button" className="button" onClick={() => setFormMode('create')}>Add your first assignment</button>}
            </>
          )}
        </section>
      )}

      {!loading && !loadError && assignments.length > 0 && (
        <>
          <p className="muted results-summary" role="status">
            Showing {assignments.length} of {meta.total} assignment{meta.total === 1 ? '' : 's'}
          </p>
          <ul className="assignment-list" aria-label="Your assignments">
            {assignments.map((assignment) => (
              <AssignmentCard
                key={assignment.id}
                assignment={assignment}
                busy={busyId === assignment.id}
                onEdit={(item) => { setNotice(null); setFormMode(item) }}
                onDelete={setToDelete}
                onToggleComplete={handleToggleComplete}
              />
            ))}
          </ul>

          {totalPages > 1 && (
            <nav className="pagination" aria-label="Assignment pages">
              <button type="button" className="button button-secondary" disabled={filters.page <= 1} onClick={() => setFilters((c) => ({ ...c, page: c.page - 1 }))}>Previous</button>
              <span>Page {meta.page} of {totalPages}</span>
              <button type="button" className="button button-secondary" disabled={filters.page >= totalPages} onClick={() => setFilters((c) => ({ ...c, page: c.page + 1 }))}>Next</button>
            </nav>
          )}
        </>
      )}

      <ConfirmDialog
        open={Boolean(toDelete)}
        title={`Delete "${toDelete?.title ?? ''}"?`}
        message="This permanently deletes the assignment. This cannot be undone."
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setToDelete(null)}
      />
    </>
  )
}
