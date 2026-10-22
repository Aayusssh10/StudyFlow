import { useEffect, useRef } from 'react'

// Uses the browser's built-in <dialog>: it traps keyboard focus and closes with Esc.
export default function ConfirmDialog({ open, title, message, confirmLabel = 'Delete', busy = false, onConfirm, onCancel }) {
  const dialogRef = useRef(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog ref={dialogRef} className="dialog" aria-labelledby="dialog-title" onCancel={onCancel}>
      <h2 id="dialog-title">{title}</h2>
      <p>{message}</p>
      <div className="dialog-actions">
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="button button-danger" onClick={onConfirm} disabled={busy}>
          {busy ? 'Deleting...' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
