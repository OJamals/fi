/** Theme-colored fi mark for the running Chat status. */
import css from './ChatView.module.css'

/**
 * Render the decorative pulsing fi silhouette with a decelerating rise and settling dot bounce.
 * @returns Vector mark; CSS keeps it still for reduced motion and forced colors.
 */
export function RunningFiMark() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <svg width="100%" height="100%" viewBox="0 0 16 16" fill="currentColor" focusable="false">
        <path d="M2.5 6.7V5.1C2.5 2.3 4.9.2 8 .2h3.3v.8c0 1.2-.7 1.8-1.9 1.8H6.8c-.9 0-1.5.7-1.5 1.9v1.9h5.5L9.2 8.3c-.7.7-1.4 1-2.4 1H5.3v4.1c0 1.6-.8 2.4-2.3 2.4h-.5V9.3H0v-.2c0-1.4 1-2.4 2.5-2.4ZM10.9 9.1l2.8-2v6.1c0 1.6-.8 2.6-2.8 2.6Z" />
        <path className={css.runningFiDot} d="M11.1 4.7c.1-.8.5-1.1 1.3-1.1h1.9L14 5.5c-.1.7-.5 1-1.2 1h-2Z" />
      </svg>
    </span>
  )
}
