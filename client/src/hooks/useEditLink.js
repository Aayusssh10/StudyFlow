import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'

// Lets another page (the calendar) open a record for editing with a link such as /tasks?edit=<id>.
// The link is used ONCE: the "edit" part is removed from the address right away, so refreshing the page or
// pressing Back does not reopen the form. A record that no longer exists is reported through onError.
export default function useEditLink({ load, onFound, onError }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const editId = searchParams.get('edit')
  const handled = useRef(null)

  useEffect(() => {
    if (!editId || handled.current === editId) return
    handled.current = editId
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.delete('edit')
        return next
      },
      { replace: true },
    )
    load(editId).then(onFound).catch(onError)
  })
}
