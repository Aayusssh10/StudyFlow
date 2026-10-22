import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { downloadExport, getReportSummary } from '../api/reports.js'
import { listSubjects } from '../api/subjects.js'
import Notice from '../components/Notice.jsx'
import PageHeader from '../components/PageHeader.jsx'
import { formatDate, formatMinutes, todayString } from '../utils/dates.js'
import { PERIODS, periodRange, studyPoints } from '../utils/reportPeriods.js'

// The charting library is large, so it is only downloaded when a chart is actually shown.
const MinutesChart = lazy(() => import('../components/DashboardCharts.jsx').then((module) => ({ default: module.MinutesChart })))
const StatusChart = lazy(() => import('../components/DashboardCharts.jsx').then((module) => ({ default: module.StatusChart })))
const chartFallback = <p className="muted" role="status">Loading chart...</p>

const EXPORTS = [
  { type: 'assignments', label: 'Assignments' },
  { type: 'tasks', label: 'Tasks' },
  { type: 'study-sessions', label: 'Study sessions' },
]

// A figure with its meaning in words. `value` is "—" when there is nothing to calculate it from.
function Figure({ id, label, value, detail }) {
  return (
    <div className="card summary-card" data-testid={`figure-${id}`}>
      <span className="summary-label">{label}</span>
      <span className="summary-value">{value}</span>
      {detail && <span className="muted stat-detail">{detail}</span>}
    </div>
  )
}

const percentText = (percent) => (percent === null ? '—' : `${percent}%`)

export default function Reports() {
  const [period, setPeriod] = useState('last30')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [subject, setSubject] = useState('')
  const [subjects, setSubjects] = useState([])
  const [reloadCount, setReloadCount] = useState(0)
  const [result, setResult] = useState({ key: null, data: null, error: '' })
  const [exporting, setExporting] = useState('')
  const [notice, setNotice] = useState(null) // { type, text }

  const today = todayString()
  const range = useMemo(() => periodRange(period, today, custom), [period, today, custom])
  const rangeError = range.from && range.to && range.from > range.to ? '"From" must not be after "To".' : ''
  const requestKey = JSON.stringify([range, subject, reloadCount])
  const loading = !rangeError && result.key !== requestKey

  useEffect(() => {
    const controller = new AbortController()
    listSubjects(controller.signal)
      .then(setSubjects)
      .catch(() => {}) // the subject filter just stays empty; the report reports its own errors
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (rangeError) return undefined
    const controller = new AbortController()
    const key = requestKey
    getReportSummary({ ...range, subject }, controller.signal)
      .then((data) => setResult({ key, data, error: '' }))
      .catch((error) => {
        if (error.name !== 'AbortError') setResult({ key, data: null, error: error.message })
      })
    return () => controller.abort()
  }, [range, subject, rangeError, requestKey])

  async function handleExport(type, label) {
    setExporting(type)
    setNotice(null)
    try {
      const filename = await downloadExport(type, { ...range, subject })
      setNotice({ type: 'success', text: `${label} exported as ${filename}.` })
    } catch (error) {
      setNotice({ type: 'error', text: error.message })
    } finally {
      setExporting('')
    }
  }

  const { data, error } = result
  const shown = !rangeError && !loading && !error ? data : null
  const over = shown ? studyPoints(shown.study, range) : null
  const periodText = range.from || range.to
    ? `${range.from ? formatDate(range.from) : 'the beginning'} to ${range.to ? formatDate(range.to) : 'today and later'}`
    : 'all time'

  return (
    <>
      <PageHeader title="Reports" subtitle="Understand your progress." />

      <form className="card filters" aria-label="Report filters" onSubmit={(event) => event.preventDefault()}>
        <div className="filters-grid report-filters">
          <div className="field">
            <label htmlFor="report-period">Period</label>
            <select id="report-period" value={period} onChange={(event) => setPeriod(event.target.value)}>
              {PERIODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </div>
          {period === 'custom' && (
            <>
              <div className="field">
                <label htmlFor="report-from">From</label>
                <input id="report-from" type="date" value={custom.from} max={custom.to || undefined} onChange={(event) => setCustom((c) => ({ ...c, from: event.target.value }))} aria-invalid={Boolean(rangeError)} />
              </div>
              <div className="field">
                <label htmlFor="report-to">To</label>
                <input id="report-to" type="date" value={custom.to} min={custom.from || undefined} onChange={(event) => setCustom((c) => ({ ...c, to: event.target.value }))} aria-invalid={Boolean(rangeError)} />
              </div>
            </>
          )}
          <div className="field">
            <label htmlFor="report-subject">Subject</label>
            <select id="report-subject" value={subject} onChange={(event) => setSubject(event.target.value)}>
              <option value="">All subjects</option>
              {subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
        </div>
        {rangeError && <p className="field-error" role="alert">{rangeError}</p>}
        <p className="muted report-note">
          Showing {periodText}. Assignments are counted by due date, tasks by their day and study time by the day of the session.
        </p>
      </form>

      {notice && <Notice type={notice.type} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

      {loading && <p className="muted" role="status">Loading report...</p>}

      {!rangeError && !loading && error && (
        <Notice type="error">
          {error}{' '}
          <button type="button" className="link-button" onClick={() => setReloadCount((count) => count + 1)}>Try again</button>
        </Notice>
      )}

      {shown && (
        <>
          <section className="stat-grid" aria-label="Report figures">
            <Figure
              id="assignment-completion"
              label="Assignment completion"
              value={percentText(shown.assignments.completionPercent)}
              detail={shown.assignments.total === 0 ? 'No assignments due in this period' : `${shown.assignments.completed} of ${shown.assignments.total} completed`}
            />
            <Figure id="pending" label="Pending assignments" value={shown.assignments.pending} detail={`${shown.assignments.overdue} overdue, ${shown.assignments.dueSoon} due soon`} />
            <Figure
              id="task-completion"
              label="Task completion"
              value={percentText(shown.tasks.completionPercent)}
              detail={shown.tasks.total === 0 ? 'No tasks in this period' : `${shown.tasks.completed} of ${shown.tasks.total} done, ${shown.tasks.overdue} overdue`}
            />
            <Figure
              id="study-time"
              label="Study time"
              value={formatMinutes(shown.study.totalMinutes)}
              detail={shown.study.sessionCount === 0 ? 'No study sessions in this period' : `${shown.study.sessionCount} session${shown.study.sessionCount === 1 ? '' : 's'} on ${shown.study.activeDays} day${shown.study.activeDays === 1 ? '' : 's'}`}
            />
            <Figure
              id="average"
              label="Average per study day"
              value={shown.study.averageMinutesPerActiveDay === null ? '—' : formatMinutes(shown.study.averageMinutesPerActiveDay)}
              detail="only days with a session count"
            />
          </section>

          <div className="dashboard-grid">
            <section className="card dashboard-panel" aria-labelledby="report-time-title">
              <h2 id="report-time-title">Study time by {over.kind}</h2>
              {shown.study.totalMinutes === 0 ? (
                <p className="muted">No study sessions in this period, so there is nothing to chart.</p>
              ) : (
                <Suspense fallback={chartFallback}>
                  <MinutesChart
                    points={over.points}
                    summary={`Study minutes by ${over.kind}: ${over.points.map((point) => `${point.label} ${point.minutes}`).join(', ')}.`}
                    totalLabel="in this period"
                    caption={`Study time by ${over.kind}`}
                    firstColumn={over.kind === 'day' ? 'Day' : 'Week'}
                  />
                </Suspense>
              )}
            </section>

            <section className="card dashboard-panel" aria-labelledby="report-status-title">
              <h2 id="report-status-title">Assignments by status</h2>
              {shown.assignments.total === 0 ? (
                <p className="muted">No assignments are due in this period, so there is nothing to chart.</p>
              ) : (
                <Suspense fallback={chartFallback}>
                  <StatusChart statuses={shown.assignments.statusDistribution} />
                </Suspense>
              )}
            </section>

            <section className="card subject-breakdown dashboard-wide" aria-labelledby="report-subject-title">
              <h2 id="report-subject-title">Study time by subject</h2>
              {shown.study.bySubject.length === 0 ? (
                <p className="muted">No study sessions in this period.</p>
              ) : (
                <ul aria-label="Study time by subject">
                  {shown.study.bySubject.map((row) => (
                    <li key={row.subjectId} style={{ '--subject-color': row.subject?.color }}>
                      <span className="subject-chip"><span className="color-dot" aria-hidden="true" />{row.subject?.name ?? 'Unknown subject'}</span>
                      <span className="breakdown-bar" aria-hidden="true"><span style={{ width: `${(row.minutes / shown.study.bySubject[0].minutes) * 100}%` }} /></span>
                      <span className="breakdown-value">
                        {formatMinutes(row.minutes)} ({Math.round((row.minutes / shown.study.totalMinutes) * 100)}%)
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}

      <section className="card export-panel" aria-labelledby="export-title">
        <h2 id="export-title">Export to CSV</h2>
        <p className="muted">Downloads the records in the period and subject chosen above, ready for a spreadsheet.</p>
        <div className="card-actions">
          {EXPORTS.map((item) => (
            <button key={item.type} type="button" className="button button-secondary" disabled={Boolean(exporting) || Boolean(rangeError)} onClick={() => handleExport(item.type, item.label)}>
              {exporting === item.type ? 'Exporting...' : `Export ${item.label.toLowerCase()}`}
            </button>
          ))}
        </div>
      </section>
    </>
  )
}
