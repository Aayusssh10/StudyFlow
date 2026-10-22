import { PRIORITIES, SORT_OPTIONS, STATUSES, TIMING_LABELS } from '../constants/assignments.js'

// The search / filter / sort bar. It only reports changes; the page decides what to do with them.
export default function AssignmentFilters({ filters, searchText, onSearchText, onChange, onClear, subjects, hasFilters }) {
  const set = (field) => (event) => onChange({ [field]: event.target.value })

  return (
    <form className="card filters" role="search" aria-label="Filter assignments" onSubmit={(event) => event.preventDefault()}>
      <div className="filters-grid">
        <div className="field field-search">
          <label htmlFor="filter-q">Search by title</label>
          <input id="filter-q" type="search" value={searchText} onChange={(event) => onSearchText(event.target.value)} maxLength={100} placeholder="e.g. essay" />
        </div>

        <div className="field">
          <label htmlFor="filter-subject">Subject</label>
          <select id="filter-subject" value={filters.subject} onChange={set('subject')}>
            <option value="">All subjects</option>
            <option value="none">No subject</option>
            {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
          </select>
        </div>

        <div className="field">
          <label htmlFor="filter-status">Status</label>
          <select id="filter-status" value={filters.status} onChange={set('status')}>
            <option value="">All statuses</option>
            {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </div>

        <div className="field">
          <label htmlFor="filter-priority">Priority</label>
          <select id="filter-priority" value={filters.priority} onChange={set('priority')}>
            <option value="">All priorities</option>
            {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
          </select>
        </div>

        <div className="field">
          <label htmlFor="filter-timing">Deadline</label>
          <select id="filter-timing" value={filters.timing} onChange={set('timing')}>
            <option value="">Any deadline</option>
            {Object.entries(TIMING_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>

        <div className="field">
          <label htmlFor="filter-dueFrom">Due from</label>
          <input id="filter-dueFrom" type="date" value={filters.dueFrom} onChange={set('dueFrom')} />
        </div>

        <div className="field">
          <label htmlFor="filter-dueTo">Due until</label>
          <input id="filter-dueTo" type="date" value={filters.dueTo} onChange={set('dueTo')} />
        </div>

        <div className="field">
          <label htmlFor="filter-sort">Sort by</label>
          <select id="filter-sort" value={filters.sort} onChange={(event) => onChange({ sort: event.target.value, order: '' })}>
            {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>

        <div className="field">
          <label htmlFor="filter-order">Order</label>
          <select id="filter-order" value={filters.order} onChange={set('order')}>
            <option value="">Default</option>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </div>
      </div>

      {hasFilters && (
        <div className="filters-footer">
          <button type="button" className="button button-secondary" onClick={onClear}>Clear filters</button>
        </div>
      )}
    </form>
  )
}
