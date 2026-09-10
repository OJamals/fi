import css from './Brand.module.css'

/** Presentation accepted from both sidebar and conversation brand slots. */
interface OfficialBrandMarkProps {
  readonly size: number
  readonly className?: string | undefined
  readonly version?: string | undefined
}

/** Render the official fi artwork with the presentation requested by its host surface. */
export function OfficialBrandMark({ size, className, version }: OfficialBrandMarkProps) {
  const mark = <img src="/fi-logo.png" alt="" width={size} height={size} className={className} />
  if (version === undefined) return mark
  return (
    <span className={css.markWithVersion}>
      {mark}
      <span className={css.version}>{version}</span>
    </span>
  )
}

/** Suppress redundant text because the official artwork already spells fi. */
export function OfficialBrandName() {
  return null
}
