import { useEffect, useState } from 'react'
import { getHealth } from '../api/client.js'

// Shows whether the API and the database are reachable (calls GET /api/health).
export default function ServerStatus() {
  const [state, setState] = useState({ level: 'loading', text: 'Checking server...' })

  useEffect(() => {
    const controller = new AbortController()
    getHealth(controller.signal)
      .then((health) => {
        if (health.database === 'connected') {
          setState({ level: 'ok', text: 'Server and database connected' })
        } else {
          setState({ level: 'warn', text: 'Server running, database not connected' })
        }
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setState({ level: 'error', text: 'Server not reachable' })
      })
    return () => controller.abort()
  }, [])

  return (
    <p className={`status status-${state.level}`} role="status">
      <span className="status-dot" aria-hidden="true" />
      {state.text}
    </p>
  )
}
