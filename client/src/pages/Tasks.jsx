import { useEffect, useMemo, useState } from 'react'
import { listAssignments } from '../api/assignments.js'
import { listSubjects } from '../api/subjects.js'
import { useSearchParams } from 'react-router-dom'
import { createTask, deleteTask, getTask, listTasks, updateTask, updateTaskCompleted } from '../api/tasks.js'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import Notice from '../components/Notice.jsx'
import PageHeader from '../components/PageHeader.jsx'
import TaskForm from '../components/TaskForm.jsx'
import TaskItem from '../components/TaskItem.jsx'
import { PRIORITIES } from '../constants/assignments.js'
import useEditLink from '../hooks/useEditLink.js'
import { addDays, formatDate, todayString } from '../utils/dates.js'

const PAGE_SIZE = 50
const VIEWS = [
  { mode: 'day', label: 'Day planner' },
  { mode: 'overdue', label: 'Overdue' },
  { mode: 'upcoming', label: 'Upcoming' },
  { mode: 'all', label: 'All tasks' },
]
const EMPTY_TEXT = {
  overdue: ['No overdue tasks', 'Everything that was planned for earlier days is done.'],
  upcoming: ['No upcoming tasks', 'Nothing is planned for the days ahead yet.'],
  all: ['No tasks yet', 'Add your first task to start planning your days.'],
}

export default function Tasks() {
  const [searchParams] = useSearchParams()
  // /tasks?view=overdue (from the dashboard) opens straight on that view. Unknown values are ignored.
  const [mode, setMode] = useState(() => (VIEWS.some((view) => view.mode === searchParams.get('view')) ? searchParams.get('view') : 'day'))
  const [day, setDay] = useState(todayString)
  const [completedFilter, setCompletedFilter] = useState('') // '' | 'false' | 'true'
  const [priority, setPriority] = useState('')
  const [searchText, setSearchText] = useState('')
  const [search, setSearch] = useState('') // the search text after a short pause in typing
  const [page, setPage] = useState(1)
  const [reloadCount, setReloadCount] = useState(0) // bump to fetch the list again
  const [result, setResult] = useState({ key: null, data: [], meta: null, error: '' })
  const [lists, setLists] = useState({ subjects: [], assignments: [], loaded: false, error: '' })
  const [listsReloadCount, setListsReloadCount] = useState(0)
  const [notice, setNotice] = useState(null) // { type, text }
  const [formMode, setFormMode] = useState(null) // null | 'create' | a task being edited
  const [toDelete, setToDelete] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const reload = () => setReloadCount((count) => count + 1)
  const today = todayString()

  // /tasks?edit=<id> (from the calendar) opens that task's edit form.
  useEditLink({
    load: getTask,
    onFound: setFormMode,
    onError: (error) => setNotice({ type: 'error', text: error.status === 404 || error.status === 400 ? 'That task could not be found. It may have been deleted.' : error.message }),
  })

  // Wait 300 ms after the last keystroke before searching, so we do not send a request per letter.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchText])

  const params = useMemo(() => {
    const scope = { day: { date: day }, overdue: { timing: 'overdue' }, upcoming: { timing: 'upcoming' }, all: {} }[mode]
    return { ...scope, completed: completedFilter, priority, q: search, page, limit: PAGE_SIZE }
  }, [mode, day, completedFilter, priority, search, page])
  const requestKey = JSON.stringify([params, reloadCount])
  const loading = result.key !== requestKey

  useEffect(() => {
    const controller = new AbortController()
    const key = requestKey
    listTasks(params, controller.signal)
      .then(({ data, meta }) => setResult({ key, data, meta, error: '' }))
      .catch((error) => {
        if (error.name !== 'AbortError') setResult({ key, data: [], meta: null, error: error.message })
      })
    return () => controller.abort()
  }, [params, requestKey])

  // Subjects and assignments feed the form's "Link to" drop-downs.
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([listSubjects(controller.signal), listAssignments({ limit: 200, sort: 'dueDate' }, controller.signal)])
      .then(([subjects, assignments]) => setLists({ subjects, assignments: assignments.data, loaded: true, error: '' }))
      .catch((error) => {
        if (error.name !== 'AbortError') setLists((current) => ({ ...current, error: error.message }))
      })
    return () => controller.abort()
  }, [listsReloadCount])

  const hasFilters = completedFilter !== '' || priority !== '' || search !== ''
  const chooseMode = (next) => { setMode(next); setPage(1) }
  const chooseDay = (next) => { if (next) { setMode('day'); setDay(next); setPage(1) } }
  const clearFilters = () => { setCompletedFilter(''); setPriority(''); setSearchText(''); setSearch(''); setPage(1) }

  async function handleSave(values) {
    const isEditing = formMode !== 'create'
    if (isEditing) await updateTask(formMode.id, values)
    else await createTask(values)

    setNotice({ type: 'success', text: isEditing ? 'Task updated.' : 'Task added.' })
    setFormMode(null)
    reload()
  }

  async function handleToggle(task) {
    setBusyId(task.id)
    try {
      await updateTaskCompleted(task.id, !task.completed)
      setNotice({ type: 'success', text: task.completed ? `Reopened "${task.title}".` : `Marked "${task.title}" as done.` })
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
      await deleteTask(toDelete.id)
      setNotice({ type: 'success', text: `Deleted "${toDelete.title}".` })
      if (result.data.length === 1 && page > 1) setPage((current) => current - 1)
      reload()
    } catch (error) {
      setNotice({ type: 'error', text: error.message })
    } finally {
      setDeleting(false)
      setToDelete(null)
    }
  }

  const { data: tasks, meta, error: loadError } = result
  const totalPages = meta ? Math.max(1, Math.ceil(meta.total / meta.limit)) : 1
  const doneCount = tasks.filter((task) => task.completed).length
  const dayHeading = `${formatDate(day)}${day === today ? ' (today)' : ''}`

  return (
    <>
      <PageHeader title="Daily tasks" subtitle="Plan what to do each day.">
        {!formMode && (
          <button type="button" className="button" onClick={() => { setNotice(null); setFormMode('create') }}>
            Add task
          </button>
        )}
      </PageHeader>

      {notice && <Notice type={notice.type} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

      {formMode && (
        <TaskForm
          key={formMode === 'create' ? 'create' : formMode.id}
          task={formMode === 'create' ? null : formMode}
          defaultDate={mode === 'day' ? day : today}
          subjects={lists.subjects}
          assignments={lists.assignments}
          listsLoaded={lists.loaded}
          listsError={lists.error}
          onSubmit={handleSave}
          onCancel={() => setFormMode(null)}
          onTargetError={() => setListsReloadCount((count) => count + 1)}
        />
      )}

      <div className="view-tabs" role="group" aria-label="Which tasks to show">
        {VIEWS.map((view) => (
          <button key={view.mode} type="button" className={`tab-button ${mode === view.mode ? 'tab-active' : ''}`} aria-pressed={mode === view.mode} onClick={() => chooseMode(view.mode)}>
            {view.label}
          </button>
        ))}
      </div>

      {mode === 'day' && (
        <div className="card day-nav">
          <button type="button" className="button button-secondary" onClick={() => chooseDay(addDays(day, -1))}>Previous day</button>
          <div className="day-nav-center">
            <h2 aria-live="polite">{dayHeading}</h2>
            <div className="field day-picker">
              <label htmlFor="day-picker">Go to date</label>
              <input id="day-picker" type="date" value={day} onChange={(event) => chooseDay(event.target.value)} />
            </div>
          </div>
          <div className="day-nav-actions">
            <button type="button" className="button button-secondary" onClick={() => chooseDay(addDays(day, 1))}>Next day</button>
            <button type="button" className="button button-secondary" onClick={() => chooseDay(todayString())} disabled={day === today}>Today</button>
          </div>
        </div>
      )}

      <form className="card filters task-filters" role="search" aria-label="Filter tasks" onSubmit={(event) => event.preventDefault()}>
        <div className="filters-grid">
          <div className="field field-search">
            <label htmlFor="task-filter-q">Search by title</label>
            <input id="task-filter-q" type="search" value={searchText} onChange={(event) => setSearchText(event.target.value)} maxLength={100} placeholder="e.g. read" />
          </div>
          <div className="field">
            <label htmlFor="task-filter-completed">Show</label>
            <select id="task-filter-completed" value={completedFilter} onChange={(event) => { setCompletedFilter(event.target.value); setPage(1) }}>
              <option value="">All tasks</option>
              <option value="false">To do</option>
              <option value="true">Done</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="task-filter-priority">Priority</label>
            <select id="task-filter-priority" value={priority} onChange={(event) => { setPriority(event.target.value); setPage(1) }}>
              <option value="">All priorities</option>
              {PRIORITIES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
        </div>
        {hasFilters && (
          <div className="filters-footer">
            <button type="button" className="button button-secondary" onClick={clearFilters}>Clear filters</button>
          </div>
        )}
      </form>

      {loading && <p className="muted" role="status">Loading tasks...</p>}

      {!loading && loadError && (
        <Notice type="error">
          {loadError}{' '}
          <button type="button" className="link-button" onClick={reload}>Try again</button>
        </Notice>
      )}

      {!loading && !loadError && tasks.length === 0 && (
        <section className="card empty-state">
          {hasFilters ? (
            <>
              <h2>No tasks match your filters</h2>
              <p>Try a different search or clear the filters.</p>
              <button type="button" className="button" onClick={clearFilters}>Clear filters</button>
            </>
          ) : mode === 'day' ? (
            <>
              <h2>Nothing planned for this day</h2>
              <p>Add a task to plan {day === today ? 'your day' : 'this day'}.</p>
              {!formMode && <button type="button" className="button" onClick={() => setFormMode('create')}>Add a task</button>}
            </>
          ) : (
            <>
              <h2>{EMPTY_TEXT[mode][0]}</h2>
              <p>{EMPTY_TEXT[mode][1]}</p>
              {mode === 'all' && !formMode && <button type="button" className="button" onClick={() => setFormMode('create')}>Add your first task</button>}
            </>
          )}
        </section>
      )}

      {!loading && !loadError && tasks.length > 0 && (
        <>
          <p className="muted results-summary" role="status">
            {mode === 'day' && !hasFilters
              ? `${doneCount} of ${tasks.length} done`
              : `Showing ${tasks.length} of ${meta.total} task${meta.total === 1 ? '' : 's'}`}
          </p>
          <ul className="task-list" aria-label="Your tasks">
            {tasks.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                showDate={mode !== 'day'}
                busy={busyId === task.id}
                onToggle={handleToggle}
                onEdit={(item) => { setNotice(null); setFormMode(item) }}
                onDelete={setToDelete}
              />
            ))}
          </ul>

          {totalPages > 1 && (
            <nav className="pagination" aria-label="Task pages">
              <button type="button" className="button button-secondary" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button>
              <span>Page {meta.page} of {totalPages}</span>
              <button type="button" className="button button-secondary" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>Next</button>
            </nav>
          )}
        </>
      )}

      <ConfirmDialog
        open={Boolean(toDelete)}
        title={`Delete "${toDelete?.title ?? ''}"?`}
        message="This permanently deletes the task. This cannot be undone."
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setToDelete(null)}
      />
    </>
  )
}
