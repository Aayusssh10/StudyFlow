import { useEffect, useMemo, useState } from 'react'
import { getCalendarEvents } from '../api/calendar.js'
import { listSubjects } from '../api/subjects.js'
import EventDialog from '../components/EventDialog.jsx'
import Notice from '../components/Notice.jsx'
import PageHeader from '../components/PageHeader.jsx'
import { EVENT_KINDS, eventLabel, groupByDay, shiftAnchor, visibleRange } from '../utils/calendar.js'
import { formatDate, formatDayLabel, formatTime, todayString } from '../utils/dates.js'
import { getSettings } from '../utils/settings.js'

const WEEKDAYS = { monday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], sunday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] }
const CHIPS_PER_DAY = 3
const ALL_TYPES = EVENT_KINDS.map((kind) => kind.type)

const monthTitle = (dateString) => {
  const [year, month] = dateString.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

// One event as a button: the text (not just the colour) says what kind of event it is.
function EventButton({ event, onOpen, compact = false }) {
  return (
    <button
      type="button"
      className={`cal-event cal-event-${event.type}${event.type === 'session' ? ` cal-state-${event.state}` : ''}${event.timing === 'completed' ? ' cal-done' : ''}`}
      onClick={() => onOpen(event)}
      data-event-type={event.type}
      title={eventLabel(event)}
    >
      <span className={compact ? 'cal-event-text' : undefined}>
        {event.time && <span className="cal-time">{formatTime(event.time)} </span>}
        {eventLabel(event)}
      </span>
    </button>
  )
}

export default function Calendar() {
  const today = todayString()
  const [view, setView] = useState('month') // 'month' | 'week'
  const [anchor, setAnchor] = useState(today) // any day inside the month/week being shown
  const [selectedDay, setSelectedDay] = useState(today)
  const [types, setTypes] = useState(ALL_TYPES)
  const [subject, setSubject] = useState('')
  const [subjects, setSubjects] = useState([])
  const [reloadCount, setReloadCount] = useState(0)
  const [result, setResult] = useState({ key: null, events: [], truncated: [], error: '' })
  const [openEvent, setOpenEvent] = useState(null)

  const range = useMemo(() => visibleRange(view, anchor), [view, anchor])
  const requestKey = JSON.stringify([range.from, range.to, types, subject, reloadCount])
  const loading = types.length > 0 && result.key !== requestKey

  useEffect(() => {
    const controller = new AbortController()
    listSubjects(controller.signal)
      .then(setSubjects)
      .catch(() => {}) // the subject filter just stays empty; the calendar itself reports its own errors
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (types.length === 0) return undefined
    const controller = new AbortController()
    const key = requestKey
    getCalendarEvents({ from: range.from, to: range.to, types, subject }, controller.signal)
      .then((data) => setResult({ key, events: data.events, truncated: data.truncated, error: '' }))
      .catch((error) => {
        if (error.name !== 'AbortError') setResult({ key, events: [], truncated: [], error: error.message })
      })
    return () => controller.abort()
  }, [range, types, subject, requestKey])

  const events = useMemo(() => (types.length === 0 || result.error ? [] : result.events), [types, result])
  const byDay = useMemo(() => groupByDay(events), [events])

  const goTo = (day) => { setAnchor(day); setSelectedDay(day) }
  const move = (delta) => {
    const next = shiftAnchor(view, anchor, delta)
    setAnchor(next)
    if (view === 'month') setSelectedDay(next)
    else setSelectedDay(shiftAnchor('week', selectedDay, delta))
  }
  const toggleType = (type) => setTypes((current) => (current.includes(type) ? current.filter((t) => t !== type) : ALL_TYPES.filter((t) => t === type || current.includes(t))))

  const title = view === 'month' ? monthTitle(anchor) : `${formatDate(range.from)} - ${formatDate(range.to)}`
  const monthPrefix = anchor.slice(0, 7)
  const dayEvents = byDay.get(selectedDay) ?? []

  return (
    <>
      <PageHeader title="Calendar" subtitle="Deadlines, tasks and study sessions on one calendar." />

      <section className="card cal-toolbar" aria-label="Calendar controls">
        <div className="cal-nav">
          <button type="button" className="button button-secondary" onClick={() => move(-1)}>
            <span aria-hidden="true">&lsaquo; </span>Previous<span className="visually-hidden"> {view}</span>
          </button>
          <button type="button" className="button button-secondary" onClick={() => goTo(today)}>Today</button>
          <button type="button" className="button button-secondary" onClick={() => move(1)}>
            Next<span className="visually-hidden"> {view}</span><span aria-hidden="true"> &rsaquo;</span>
          </button>
          <h2 className="cal-title" aria-live="polite" data-testid="calendar-title">{title}</h2>
        </div>

        <div className="cal-options">
          <div className="view-tabs" role="group" aria-label="Calendar view">
            {['month', 'week'].map((mode) => (
              <button key={mode} type="button" className={`tab-button${view === mode ? ' tab-active' : ''}`} aria-pressed={view === mode} onClick={() => setView(mode)}>
                {mode === 'month' ? 'Month' : 'Week'}
              </button>
            ))}
          </div>

          <fieldset className="cal-types">
            <legend className="visually-hidden">Show these kinds of events</legend>
            {EVENT_KINDS.map((kind) => (
              <label key={kind.type} className={`cal-type cal-type-${kind.type}`}>
                <input type="checkbox" checked={types.includes(kind.type)} onChange={() => toggleType(kind.type)} />
                <span className="cal-swatch" aria-hidden="true" />{kind.label}
              </label>
            ))}
          </fieldset>

          <div className="field cal-subject">
            <label htmlFor="calendar-subject">Subject</label>
            <select id="calendar-subject" value={subject} onChange={(event) => setSubject(event.target.value)}>
              <option value="">All subjects</option>
              {subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
        </div>
      </section>

      {result.error && types.length > 0 && !loading && (
        <Notice type="error">
          {result.error}{' '}
          <button type="button" className="link-button" onClick={() => setReloadCount((count) => count + 1)}>Try again</button>
        </Notice>
      )}
      {types.length === 0 && <p className="muted" role="status">Choose at least one kind of event to show.</p>}
      {loading && <p className="muted" role="status">Loading calendar...</p>}
      {!loading && result.truncated.length > 0 && types.length > 0 && (
        <p className="muted" role="status">Some days have too many events to show them all. Narrow the view with the filters above.</p>
      )}
      {!loading && !result.error && types.length > 0 && events.length === 0 && (
        <p className="muted cal-empty" role="status">
          Nothing is scheduled {view === 'month' ? 'this month' : 'this week'}{subject ? ' for this subject' : ''}.
        </p>
      )}

      <div className={loading ? 'cal-loading' : undefined} aria-busy={loading}>
        {view === 'month' ? (
          <table className="cal-grid">
            <caption className="visually-hidden">{title}</caption>
            <thead>
              <tr>{WEEKDAYS[getSettings().weekStart].map((day) => <th key={day} scope="col">{day}</th>)}</tr>
            </thead>
            <tbody>
              {Array.from({ length: range.days.length / 7 }, (_, week) => (
                <tr key={range.days[week * 7]}>
                  {range.days.slice(week * 7, week * 7 + 7).map((day) => {
                    const list = byDay.get(day) ?? []
                    const outside = !day.startsWith(monthPrefix)
                    return (
                      <td key={day} className={`cal-cell${outside ? ' cal-outside' : ''}${day === today ? ' cal-today' : ''}${day === selectedDay ? ' cal-selected' : ''}`} data-date={day}>
                        <button type="button" className="cal-day" aria-pressed={day === selectedDay} aria-label={`${formatDate(day)}${day === today ? ' (today)' : ''}, ${list.length} event${list.length === 1 ? '' : 's'}`} onClick={() => setSelectedDay(day)}>
                          {Number(day.slice(8))}
                        </button>
                        {list.slice(0, CHIPS_PER_DAY).map((event) => <EventButton key={`${event.type}-${event.id}`} event={event} onOpen={setOpenEvent} compact />)}
                        {list.length > CHIPS_PER_DAY && (
                          <button type="button" className="link-button cal-more" onClick={() => setSelectedDay(day)}>
                            +{list.length - CHIPS_PER_DAY} more
                          </button>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ul className="cal-week" aria-label={`Week of ${formatDate(range.from)}`}>
            {range.days.map((day) => {
              const list = byDay.get(day) ?? []
              return (
                <li key={day} className={`card cal-week-day${day === today ? ' cal-today' : ''}`} data-date={day}>
                  <h3>{formatDayLabel(day)}{day === today && <span className="badge badge-timing-upcoming"> Today</span>}</h3>
                  {list.length === 0 ? <p className="muted">Nothing scheduled</p> : (
                    <ul className="cal-week-events">
                      {list.map((event) => <li key={`${event.type}-${event.id}`}><EventButton event={event} onOpen={setOpenEvent} /></li>)}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {view === 'month' && (
        <section className="card cal-agenda" aria-labelledby="agenda-title">
          <h2 id="agenda-title">{formatDate(selectedDay)}{selectedDay === today && ' (today)'}</h2>
          {loading ? null : dayEvents.length === 0 ? (
            <p className="muted">Nothing is scheduled for this day.</p>
          ) : (
            <ul className="cal-agenda-list" aria-label="Events on the selected day">
              {dayEvents.map((event) => <li key={`${event.type}-${event.id}`}><EventButton event={event} onOpen={setOpenEvent} /></li>)}
            </ul>
          )}
        </section>
      )}

      <EventDialog event={openEvent} onClose={() => setOpenEvent(null)} />
    </>
  )
}
