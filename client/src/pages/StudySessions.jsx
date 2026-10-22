import { useEffect, useMemo, useState } from 'react'
import { listAssignments } from '../api/assignments.js'
import {
  createStudySession,
  deleteStudySession,
  getStudySession,
  getStudySummary,
  listStudySessions,
  updateStudySession,
} from '../api/studySessions.js'
import { listSubjects } from '../api/subjects.js'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import Notice from '../components/Notice.jsx'
import PageHeader from '../components/PageHeader.jsx'
import SessionForm from '../components/SessionForm.jsx'
import SessionItem from '../components/SessionItem.jsx'
import { SESSION_SORTS, SESSION_TYPES } from '../constants/sessions.js'
import useEditLink from '../hooks/useEditLink.js'
import { formatMinutes, todayString, weekRange } from '../utils/dates.js'

const PAGE_SIZE = 20
const NO_FILTERS = { dateFrom: '', dateTo: '', subject: '', type: '' }

export default function StudySessions() {
  const [filters, setFilters] = useState(NO_FILTERS)
  const [sort, setSort] = useState({ sort: 'date', order: '' })
  const [searchText, setSearchText] = useState('')
  const [search, setSearch] = useState('') // the search text after a short pause in typing
  const [page, setPage] = useState(1)
  const [reloadCount, setReloadCount] = useState(0) // bump to fetch everything again
  const [result, setResult] = useState({ key: null, sessions: [], meta: null, summary: null, today: null, week: null, error: '' })
  const [lists, setLists] = useState({ subjects: [], assignments: [], loaded: false, error: '' })
  const [listsReloadCount, setListsReloadCount] = useState(0)
  const [notice, setNotice] = useState(null) // { type, text }
  const [formMode, setFormMode] = useState(null) // null | 'create' | a session being edited
  const [toDelete, setToDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const reload = () => setReloadCount((count) => count + 1)

  // /study-sessions?edit=<id> (from the calendar) opens that session's edit form.
  useEditLink({
    load: getStudySession,
    onFound: setFormMode,
    onError: (error) => setNotice({ type: 'error', text: error.status === 404 || error.status === 400 ? 'That study session could not be found. It may have been deleted.' : error.message }),
  })

  // Wait 300 ms after the last keystroke before searching, so we do not send a request per letter.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchText])

  // The same filters are used for the list and for the "current view" totals.
  const filterParams = useMemo(() => ({ ...filters, q: search }), [filters, search])
  const listParams = useMemo(() => ({ ...filterParams, ...sort, page, limit: PAGE_SIZE }), [filterParams, sort, page])
  const requestKey = JSON.stringify([listParams, reloadCount])
  const loading = result.key !== requestKey

  useEffect(() => {
    const controller = new AbortController()
    const key = requestKey
    const { signal } = controller
    const today = todayString()
    const week = weekRange(today)
    // Totals are CALCULATED by the server from the stored sessions: never typed in or hard-coded here.
    Promise.all([
      listStudySessions(listParams, signal),
      getStudySummary(filterParams, signal),
      getStudySummary({ date: today }, signal),
      getStudySummary({ dateFrom: week.from, dateTo: week.to }, signal),
    ])
      .then(([listing, summary, todaySummary, weekSummary]) =>
        setResult({ key, sessions: listing.data, meta: listing.meta, summary, today: todaySummary, week: weekSummary, error: '' }))
      .catch((error) => {
        if (error.name !== 'AbortError') setResult({ key, sessions: [], meta: null, summary: null, today: null, week: null, error: error.message })
      })
    return () => controller.abort()
  }, [listParams, filterParams, requestKey])

  // Subjects and assignments feed the filter and the form's drop-downs.
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([listSubjects(controller.signal), listAssignments({ limit: 200, sort: 'dueDate' }, controller.signal)])
      .then(([subjects, assignments]) => setLists({ subjects, assignments: assignments.data, loaded: true, error: '' }))
      .catch((error) => {
        if (error.name !== 'AbortError') setLists((current) => ({ ...current, error: error.message }))
      })
    return () => controller.abort()
  }, [listsReloadCount])

  const hasFilters = Object.values(filters).some((value) => value !== '') || search !== ''
  const changeFilter = (changes) => { setFilters((current) => ({ ...current, ...changes })); setPage(1) }
  const clearFilters = () => { setFilters(NO_FILTERS); setSearchText(''); setSearch(''); setPage(1) }

  async function handleSave(values) {
    const isEditing = formMode !== 'create'
    if (isEditing) await updateStudySession(formMode.id, values)
    else await createStudySession(values)

    setNotice({ type: 'success', text: isEditing ? 'Study session updated.' : 'Study session added.' })
    setFormMode(null)
    reload()
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await deleteStudySession(toDelete.id)
      setNotice({ type: 'success', text: 'Study session deleted.' })
      if (result.sessions.length === 1 && page > 1) setPage((current) => current - 1)
      reload()
    } catch (error) {
      setNotice({ type: 'error', text: error.message })
    } finally {
      setDeleting(false)
      setToDelete(null)
    }
  }

  const { sessions, meta, summary, today, week, error: loadError } = result
  const totalPages = meta ? Math.max(1, Math.ceil(meta.total / meta.limit)) : 1
  const maxSubjectMinutes = summary ? Math.max(1, ...summary.bySubject.map((row) => row.minutes)) : 1

  return (
    <>
      <PageHeader title="Study sessions" subtitle="Record how long you studied.">
        {!formMode && (
          <button type="button" className="button" onClick={() => { setNotice(null); setFormMode('create') }}>
            Add session
          </button>
        )}
      </PageHeader>

      {notice && <Notice type={notice.type} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

      {formMode && (
        <SessionForm
          key={formMode === 'create' ? 'create' : formMode.id}
          session={formMode === 'create' ? null : formMode}
          defaultDate={todayString()}
          subjects={lists.subjects}
          assignments={lists.assignments}
          listsLoaded={lists.loaded}
          listsError={lists.error}
          onSubmit={handleSave}
          onCancel={() => setFormMode(null)}
          onTargetError={() => setListsReloadCount((count) => count + 1)}
        />
      )}

      <section aria-label="Study time totals" className="summary-grid">
        <div className="card summary-card">
          <p className="summary-label">Today</p>
          <p className="summary-value" data-testid="total-today">{today ? formatMinutes(today.totalMinutes) : '...'}</p>
          <p className="muted">{today ? `${today.sessionCount} session${today.sessionCount === 1 ? '' : 's'}` : ''}</p>
        </div>
        <div className="card summary-card">
          <p className="summary-label">This week (Mon to Sun)</p>
          <p className="summary-value" data-testid="total-week">{week ? formatMinutes(week.totalMinutes) : '...'}</p>
          <p className="muted">{week ? `${week.sessionCount} session${week.sessionCount === 1 ? '' : 's'}` : ''}</p>
        </div>
        <div className="card summary-card">
          <p className="summary-label">{hasFilters ? 'In the current filter' : 'All time'}</p>
          <p className="summary-value" data-testid="total-view">{summary ? formatMinutes(summary.totalMinutes) : '...'}</p>
          <p className="muted">{summary ? `${summary.sessionCount} session${summary.sessionCount === 1 ? '' : 's'}` : ''}</p>
        </div>
      </section>

      {summary && summary.bySubject.length > 0 && (
        <section className="card subject-breakdown" aria-label="Study time by subject">
          <h2>Time by subject</h2>
          <ul>
            {summary.bySubject.map((row) => (
              <li key={row.subjectId} style={{ '--subject-color': row.subject?.color }}>
                <span className="subject-chip"><span className="color-dot" aria-hidden="true" />{row.subject?.name ?? 'Unknown subject'}</span>
                <span className="breakdown-bar" aria-hidden="true"><span style={{ width: `${(row.minutes / maxSubjectMinutes) * 100}%` }} /></span>
                <span className="breakdown-value">{formatMinutes(row.minutes)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form className="card filters" role="search" aria-label="Filter study sessions" onSubmit={(event) => event.preventDefault()}>
        <div className="filters-grid">
          <div className="field field-search">
            <label htmlFor="session-filter-q">Search notes</label>
            <input id="session-filter-q" type="search" value={searchText} onChange={(event) => setSearchText(event.target.value)} maxLength={100} placeholder="e.g. chapter 3" />
          </div>
          <div className="field">
            <label htmlFor="session-filter-subject">Subject</label>
            <select id="session-filter-subject" value={filters.subject} onChange={(event) => changeFilter({ subject: event.target.value })}>
              <option value="">All subjects</option>
              {lists.subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="session-filter-type">Type</label>
            <select id="session-filter-type" value={filters.type} onChange={(event) => changeFilter({ type: event.target.value })}>
              <option value="">All types</option>
              {SESSION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="session-filter-from">From</label>
            <input id="session-filter-from" type="date" value={filters.dateFrom} onChange={(event) => changeFilter({ dateFrom: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="session-filter-to">Until</label>
            <input id="session-filter-to" type="date" value={filters.dateTo} onChange={(event) => changeFilter({ dateTo: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="session-filter-sort">Sort by</label>
            <select id="session-filter-sort" value={sort.sort} onChange={(event) => { setSort({ sort: event.target.value, order: '' }); setPage(1) }}>
              {SESSION_SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="session-filter-order">Order</label>
            <select id="session-filter-order" value={sort.order} onChange={(event) => { setSort((current) => ({ ...current, order: event.target.value })); setPage(1) }}>
              <option value="">Default</option>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </div>
        </div>
        {hasFilters && (
          <div className="filters-footer">
            <button type="button" className="button button-secondary" onClick={clearFilters}>Clear filters</button>
          </div>
        )}
      </form>

      {loading && <p className="muted" role="status">Loading study sessions...</p>}

      {!loading && loadError && (
        <Notice type="error">
          {loadError}{' '}
          <button type="button" className="link-button" onClick={reload}>Try again</button>
        </Notice>
      )}

      {!loading && !loadError && sessions.length === 0 && (
        <section className="card empty-state">
          {hasFilters ? (
            <>
              <h2>No study sessions match your filters</h2>
              <p>Try a different search or clear the filters.</p>
              <button type="button" className="button" onClick={clearFilters}>Clear filters</button>
            </>
          ) : (
            <>
              <h2>No study sessions yet</h2>
              <p>Record your first session to start tracking study time.</p>
              {!formMode && <button type="button" className="button" onClick={() => setFormMode('create')}>Add your first session</button>}
            </>
          )}
        </section>
      )}

      {!loading && !loadError && sessions.length > 0 && (
        <>
          <p className="muted results-summary" role="status">
            Showing {sessions.length} of {meta.total} session{meta.total === 1 ? '' : 's'}
          </p>
          <ul className="task-list" aria-label="Your study sessions">
            {sessions.map((session) => (
              <SessionItem key={session.id} session={session} onEdit={(item) => { setNotice(null); setFormMode(item) }} onDelete={setToDelete} />
            ))}
          </ul>

          {totalPages > 1 && (
            <nav className="pagination" aria-label="Study session pages">
              <button type="button" className="button button-secondary" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button>
              <span>Page {meta.page} of {totalPages}</span>
              <button type="button" className="button button-secondary" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>Next</button>
            </nav>
          )}
        </>
      )}

      <ConfirmDialog
        open={Boolean(toDelete)}
        title="Delete this study session?"
        message={toDelete ? `This permanently deletes the ${formatMinutes(toDelete.durationMinutes)} session for ${toDelete.subject?.name ?? 'this subject'}. This cannot be undone.` : ''}
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setToDelete(null)}
      />
    </>
  )
}
