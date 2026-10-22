import { lazy, Suspense, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getDashboardStats } from '../api/dashboard.js'
import Notice from '../components/Notice.jsx'
import PageHeader from '../components/PageHeader.jsx'
import { TIMING_LABELS } from '../constants/assignments.js'
import { formatDate, formatMinutes, formatTime } from '../utils/dates.js'

// The charting library is large, so it is only downloaded when a chart is actually shown.
const StudyChart = lazy(() => import('../components/DashboardCharts.jsx').then((module) => ({ default: module.StudyChart })))
const StatusChart = lazy(() => import('../components/DashboardCharts.jsx').then((module) => ({ default: module.StatusChart })))
const chartFallback = <p className="muted" role="status">Loading chart...</p>

const TASK_TIMING_LABELS = { overdue: 'Overdue', today: 'Today', upcoming: 'Upcoming', completed: 'Done' }
const ACTIVITY_PAGES = { assignment: 'assignments', task: 'tasks', session: 'study-sessions' }
const ACTIVITY_NAMES = { assignment: 'assignment', task: 'task', session: 'study session' }

// A figure that links to the page where its records can be seen.
function StatCard({ label, value, detail, to, tone }) {
  return (
    <Link to={to} className={`card stat-card${tone ? ` stat-${tone}` : ''}`}>
      <span className="summary-label">{label}</span>
      <span className="summary-value" data-testid={`stat-${label.toLowerCase().replace(/\W+/g, '-')}`}>{value}</span>
      {detail && <span className="muted stat-detail">{detail}</span>}
    </Link>
  )
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

export default function Dashboard() {
  const [reloadCount, setReloadCount] = useState(0)
  const [state, setState] = useState({ key: null, data: null, error: '' })
  const loading = state.key !== reloadCount

  useEffect(() => {
    const controller = new AbortController()
    const key = reloadCount
    getDashboardStats(controller.signal)
      .then((data) => setState({ key, data, error: '' }))
      .catch((error) => {
        if (error.name !== 'AbortError') setState({ key, data: null, error: error.message })
      })
    return () => controller.abort()
  }, [reloadCount])

  const { data, error } = state
  const counts = data?.counts
  const isNewUser = Boolean(
    counts && counts.subjects === 0 && counts.assignments.total === 0 && counts.study.sessionCount === 0 && counts.tasks.today === 0,
  )

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Your study overview at a glance." />

      {loading && <p className="muted" role="status">Loading your dashboard...</p>}

      {!loading && error && (
        <Notice type="error">
          {error}{' '}
          <button type="button" className="link-button" onClick={() => setReloadCount((count) => count + 1)}>Try again</button>
        </Notice>
      )}

      {!loading && data && (
        <>
          {isNewUser && (
            <section className="card empty-state dashboard-welcome" aria-labelledby="welcome-title">
              <h2 id="welcome-title">Welcome to StudyFlow</h2>
              <p>Nothing here yet. Start by adding the subjects you study, then your assignments, daily tasks and study sessions. This page fills in as you go.</p>
              <div className="card-actions">
                <Link className="button" to="/subjects">Add your first subject</Link>
                <Link className="button button-secondary" to="/assignments">Add an assignment</Link>
              </div>
            </section>
          )}

          <section className="stat-grid" aria-label="Summary">
            <StatCard label="Subjects" value={counts.subjects} to="/subjects" />
            <StatCard
              label="Pending assignments"
              value={counts.assignments.pending}
              detail={`${counts.assignments.completed} of ${counts.assignments.total} completed`}
              to="/assignments"
            />
            <StatCard label="Overdue assignments" value={counts.assignments.overdue} to="/assignments?timing=overdue" tone={counts.assignments.overdue > 0 ? 'danger' : undefined} />
            <StatCard label="Due soon" value={counts.assignments.dueSoon} detail="within the next 3 days" to="/assignments?timing=dueSoon" tone={counts.assignments.dueSoon > 0 ? 'warning' : undefined} />
            <StatCard label="Tasks today" value={`${counts.tasks.todayDone} / ${counts.tasks.today}`} detail="done / planned" to="/tasks" />
            <StatCard label="Overdue tasks" value={counts.tasks.overdue} to="/tasks?view=overdue" tone={counts.tasks.overdue > 0 ? 'danger' : undefined} />
            <StatCard label="Study today" value={formatMinutes(counts.study.todayMinutes)} to="/study-sessions" />
            <StatCard
              label="Study this week"
              value={formatMinutes(counts.study.weekMinutes)}
              detail={`${formatDate(counts.study.week.from)} - ${formatDate(counts.study.week.to)}`}
              to="/study-sessions"
            />
          </section>

          <div className="dashboard-grid">
            <section className="card dashboard-panel" aria-labelledby="today-title">
              <h2 id="today-title">Today</h2>
              {data.today.tasks.length === 0 && data.today.sessions.length === 0 ? (
                <p className="muted">Nothing is planned for today. <Link to="/tasks">Plan a task</Link> or <Link to="/study-sessions">log a study session</Link>.</p>
              ) : (
                <>
                  {data.today.tasks.length > 0 && (
                    <>
                      <h3>Tasks</h3>
                      <ul className="dashboard-list" aria-label="Today's tasks">
                        {data.today.tasks.map((task) => (
                          <li key={task.id} className={`timing-${task.timing}`}>
                            <span className={task.completed ? 'done-title' : undefined}>{task.title}</span>
                            <span className="muted">{task.time ? formatTime(task.time) : 'Any time'}</span>
                            <span className={`badge badge-task-${task.timing}`}>{TASK_TIMING_LABELS[task.timing]}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {data.today.sessions.length > 0 && (
                    <>
                      <h3>Study sessions</h3>
                      <ul className="dashboard-list" aria-label="Today's study sessions">
                        {data.today.sessions.map((session) => (
                          <li key={session.id}>
                            <span>{session.subject?.name ?? 'Unknown subject'}</span>
                            <span className="muted">{session.startTime ? formatTime(session.startTime) : 'Any time'}</span>
                            <span className="badge badge-neutral">{formatMinutes(session.durationMinutes)}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </section>

            <section className="card dashboard-panel" aria-labelledby="deadlines-title">
              <h2 id="deadlines-title">Upcoming deadlines</h2>
              {data.upcomingDeadlines.length === 0 ? (
                <p className="muted">No pending assignments. <Link to="/assignments">Add an assignment</Link> to track a deadline.</p>
              ) : (
                <ul className="dashboard-list" aria-label="Upcoming deadlines">
                  {data.upcomingDeadlines.map((assignment) => (
                    <li key={assignment.id} className={`timing-${assignment.timing}`}>
                      <span>{assignment.title}</span>
                      <span className="muted">{formatDate(assignment.dueDate)}{assignment.dueTime && ` at ${formatTime(assignment.dueTime)}`}</span>
                      <span className={`badge badge-timing-${assignment.timing}`}>{TIMING_LABELS[assignment.timing]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card dashboard-panel" aria-labelledby="study-title">
              <h2 id="study-title">Study time, last 7 days</h2>
              {data.studyLast7Days.every((day) => day.minutes === 0) ? (
                <p className="muted">No study sessions in the last 7 days. <Link to="/study-sessions">Log a session</Link> and your chart will appear here.</p>
              ) : (
                <Suspense fallback={chartFallback}><StudyChart days={data.studyLast7Days} /></Suspense>
              )}
            </section>

            <section className="card dashboard-panel" aria-labelledby="status-title">
              <h2 id="status-title">Assignments by status</h2>
              {counts.assignments.total === 0 ? (
                <p className="muted">No assignments yet, so there is nothing to chart.</p>
              ) : (
                <Suspense fallback={chartFallback}><StatusChart statuses={data.assignmentStatus} /></Suspense>
              )}
            </section>

            <section className="card dashboard-panel dashboard-wide" aria-labelledby="activity-title">
              <h2 id="activity-title">Recent activity</h2>
              {data.recentActivity.length === 0 ? (
                <p className="muted">Nothing has been added yet.</p>
              ) : (
                <ul className="dashboard-list" aria-label="Recent activity">
                  {data.recentActivity.map((item) => (
                    <li key={`${item.type}-${item.id}`}>
                      <span>
                        {item.action === 'added' ? 'Added' : 'Updated'} {ACTIVITY_NAMES[item.type]}{' '}
                        <Link to={`/${ACTIVITY_PAGES[item.type]}?edit=${item.id}`}>
                          {item.type === 'session' ? `${item.title} (${plural(item.durationMinutes, 'min')})` : item.title}
                        </Link>
                      </span>
                      <span className="muted">{new Date(item.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </>
  )
}
