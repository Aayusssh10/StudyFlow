import { Link } from 'react-router-dom'
import PageHeader from '../components/PageHeader.jsx'

export default function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <section className="card empty-state">
        <p>That page does not exist.</p>
        <Link className="button" to="/">Back to the dashboard</Link>
      </section>
    </>
  )
}
