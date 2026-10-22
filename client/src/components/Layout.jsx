import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import Icon from './Icon.jsx'
import ServerStatus from './ServerStatus.jsx'

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/subjects', label: 'Subjects', icon: 'subjects' },
  { to: '/assignments', label: 'Assignments', icon: 'assignments' },
  { to: '/tasks', label: 'Daily tasks', icon: 'tasks' },
  { to: '/calendar', label: 'Calendar', icon: 'calendar' },
  { to: '/study-sessions', label: 'Study sessions', icon: 'sessions' },
  { to: '/reports', label: 'Reports', icon: 'reports' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
]

// The browser tab / screen-reader title for the page being shown ("Reports - StudyFlow").
const pageTitle = (pathname) => {
  const item = NAV_ITEMS.find((candidate) => (candidate.end ? pathname === candidate.to : pathname.startsWith(candidate.to)))
  return `${item ? item.label : 'Page not found'} - StudyFlow`
}

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const { pathname } = useLocation()
  const mainRef = useRef(null)
  const shownPath = useRef(null) // the page shown before this one (null on the very first load)

  // After moving to another page: update the title, and move keyboard focus to the new content so keyboard and
  // screen-reader users start at the top of the page instead of on the old link. Comparing with the previous page
  // (instead of counting renders) means a first load, or React running this effect twice in development, never
  // steals focus from the skip link.
  useEffect(() => {
    document.title = pageTitle(pathname)
    if (shownPath.current !== null && shownPath.current !== pathname) mainRef.current?.focus()
    shownPath.current = pathname
  }, [pathname])

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to main content</a>

      <header className="mobile-bar">
        <span className="brand">StudyFlow</span>
        <button
          type="button"
          className="icon-button"
          aria-expanded={menuOpen}
          aria-controls="sidebar"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon name={menuOpen ? 'close' : 'menu'} />
        </button>
      </header>

      <aside id="sidebar" className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
        <div className="brand brand-desktop">
          <span className="brand-mark" aria-hidden="true">S</span>
          StudyFlow
        </div>
        <nav aria-label="Main navigation">
          <ul className="nav-list">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                {/* Clicking a link closes the mobile menu */}
                <NavLink to={item.to} end={item.end} className="nav-link" onClick={() => setMenuOpen(false)}>
                  <Icon name={item.icon} />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sidebar-footer">
          <ServerStatus />
          <p className="demo-note">Local demo app. No login, data is not private.</p>
        </div>
      </aside>

      <main id="main" ref={mainRef} className="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  )
}
