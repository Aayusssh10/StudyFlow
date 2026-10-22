// Success / error message. Errors use role="alert" so screen readers announce them immediately.
export default function Notice({ type = 'success', children, onDismiss }) {
  return (
    <div className={`notice notice-${type}`} role={type === 'error' ? 'alert' : 'status'}>
      <span>{children}</span>
      {onDismiss && (
        <button type="button" className="notice-close" onClick={onDismiss} aria-label="Dismiss message">
          &times;
        </button>
      )}
    </div>
  )
}
