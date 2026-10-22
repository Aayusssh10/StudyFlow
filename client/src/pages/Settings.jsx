import { useState } from 'react'
import Notice from '../components/Notice.jsx'
import PageHeader from '../components/PageHeader.jsx'
import useSettings from '../hooks/useSettings.js'
import { formatDate, formatTime, todayString } from '../utils/dates.js'
import { DATE_FORMATS, TIME_FORMATS, WEEK_STARTS, resetSettings, saveSettings } from '../utils/settings.js'

// Settings are kept in this browser only (there are no accounts); every change is saved at once.
export default function Settings() {
  const settings = useSettings()
  const [message, setMessage] = useState(null) // { type, text }

  function change(changes) {
    const saved = saveSettings(changes)
    setMessage(saved
      ? { type: 'success', text: 'Saved in this browser.' }
      : { type: 'error', text: 'Your browser blocked saving, so this only lasts until you close the page.' })
  }

  function reset() {
    const saved = resetSettings()
    setMessage(saved
      ? { type: 'success', text: 'Settings reset to the defaults.' }
      : { type: 'error', text: 'Your browser blocked saving, so this only lasts until you close the page.' })
  }

  const today = todayString()

  return (
    <>
      <PageHeader title="Settings" subtitle="Personalize StudyFlow." />

      {message && <Notice type={message.type} onDismiss={() => setMessage(null)}>{message.text}</Notice>}

      <section className="card settings-card" aria-label="Preferences">
        <fieldset className="settings-group">
          <legend>Week starts on</legend>
          <p className="field-hint">Used for "this week" on the dashboard, study sessions and reports, and for the calendar.</p>
          {WEEK_STARTS.map((option) => (
            <label key={option.value} className="settings-choice">
              <input type="radio" name="weekStart" value={option.value} checked={settings.weekStart === option.value} onChange={() => change({ weekStart: option.value })} />
              {option.label}
            </label>
          ))}
        </fieldset>

        <div className="field">
          <label htmlFor="setting-dateFormat">Date format</label>
          <select id="setting-dateFormat" value={settings.dateFormat} onChange={(event) => change({ dateFormat: event.target.value })}>
            {DATE_FORMATS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <p className="field-hint">Date boxes in forms always follow your browser's own language.</p>
        </div>

        <div className="field">
          <label htmlFor="setting-timeFormat">Time format</label>
          <select id="setting-timeFormat" value={settings.timeFormat} onChange={(event) => change({ timeFormat: event.target.value })}>
            {TIME_FORMATS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>

        <p className="settings-preview" data-testid="settings-preview">
          Preview: <strong>{formatDate(today)}</strong> at <strong>{formatTime('14:30')}</strong>
        </p>

        <div className="card-actions">
          <button type="button" className="button button-secondary" onClick={reset}>Reset to defaults</button>
        </div>
        <p className="muted">These preferences are saved only in this browser. Clearing the site's data in your browser resets them.</p>
      </section>
    </>
  )
}
