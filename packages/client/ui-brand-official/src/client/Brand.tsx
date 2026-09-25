import css from './Brand.module.css'

/** Presentation accepted from both sidebar and conversation brand slots. */
interface OfficialBrandMarkProps {
  readonly size: number
  readonly className?: string | undefined
}

/** Render the theme-responsive official fi artwork with the presentation requested by its host surface. */
export function OfficialBrandMark({ size, className }: OfficialBrandMarkProps) {
  const imageClassName = className === undefined ? css.artwork : `${css.artwork} ${className}`
  return <img src="/fi-logo.png" alt="" width={size} height={size} className={imageClassName} />
}

/** Suppress redundant text because the official artwork already spells fi. */
export function OfficialBrandName() {
  return null
}
