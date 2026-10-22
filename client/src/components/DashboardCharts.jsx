import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDate, formatDayLabel, formatMinutes } from '../utils/dates.js'

// Colours are never the only signal: every bar has a text label (axis or value) and the same numbers are
// available as a table under each chart.
const STUDY_COLOR = '#4f46e5'
const STATUS_COLORS = { 'Not Started': '#6b7280', 'In Progress': '#d97706', Completed: '#15803d' }

function ChartTable({ caption, columns, rows }) {
  return (
    <details className="chart-table">
      <summary>View as a table</summary>
      <table>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]}>{row.map((cell, index) => (index === 0 ? <th key={index} scope="row">{cell}</th> : <td key={index}>{cell}</td>))}</tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

function MinutesTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const { title, minutes } = payload[0].payload
  return (
    <div className="chart-tooltip">
      <strong>{title}</strong>
      <span>{minutes === 0 ? 'No study' : formatMinutes(minutes)}</span>
    </div>
  )
}

// Bars of study minutes. `points` is [{ key, label (axis), title (tooltip / table row), minutes }].
// `summary` is the full text description (for screen readers); `totalLabel` e.g. "in the last 7 days".
export function MinutesChart({ points, summary, totalLabel, caption, firstColumn }) {
  const total = points.reduce((sum, point) => sum + point.minutes, 0)

  return (
    <div>
      <p className="muted chart-total">{formatMinutes(total)} {totalLabel}</p>
      <div className="chart-box" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="#e5e7eb" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: '#4b5563', fontSize: 12 }} interval="preserveStartEnd" minTickGap={12} />
            <YAxis width={44} allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#4b5563', fontSize: 12 }} unit=" m" />
            <Tooltip content={<MinutesTooltip />} cursor={{ fill: 'rgba(79, 70, 229, 0.08)' }} />
            <Bar dataKey="minutes" fill={STUDY_COLOR} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartTable
        caption={caption}
        columns={[firstColumn, 'Study time']}
        rows={points.map((point) => [point.title, point.minutes === 0 ? '0 min' : formatMinutes(point.minutes)])}
      />
    </div>
  )
}

// Minutes studied on each of the last 7 days (days without study show as 0).
export function StudyChart({ days }) {
  return (
    <MinutesChart
      points={days.map((day) => ({ key: day.date, label: formatDayLabel(day.date), title: formatDate(day.date), minutes: day.minutes }))}
      summary={`Study minutes for each of the last 7 days: ${days.map((day) => `${formatDayLabel(day.date)} ${day.minutes}`).join(', ')}.`}
      totalLabel="in the last 7 days"
      caption="Study time per day for the last 7 days"
      firstColumn="Day"
    />
  )
}

// How many assignments are Not Started / In Progress / Completed.
export function StatusChart({ statuses }) {
  const total = statuses.reduce((sum, row) => sum + row.count, 0)
  const summary = `Assignments by status: ${statuses.map((row) => `${row.status} ${row.count}`).join(', ')}.`

  return (
    <div>
      <p className="muted chart-total">{total} assignment{total === 1 ? '' : 's'} in total</p>
      <div className="chart-box" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height={170}>
          <BarChart data={statuses} layout="vertical" margin={{ top: 4, right: 36, bottom: 0, left: 0 }}>
            <XAxis type="number" hide domain={[0, 'dataMax']} />
            <YAxis type="category" dataKey="status" width={92} tickLine={false} axisLine={false} tick={{ fill: '#374151', fontSize: 13 }} />
            <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={22} isAnimationActive={false}>
              {statuses.map((row) => <Cell key={row.status} fill={STATUS_COLORS[row.status]} />)}
              <LabelList dataKey="count" position="right" fill="#1f2937" fontSize={13} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartTable caption="Assignments by status" columns={['Status', 'Assignments']} rows={statuses.map((row) => [row.status, row.count])} />
    </div>
  )
}
