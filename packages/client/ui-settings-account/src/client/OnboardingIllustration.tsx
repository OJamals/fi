/**
 * Paired artwork follows the page's light and dark theme selectors. Each
 * variant is a separate on-demand client chunk, so only the active step's and
 * locale's pair is fetched; the two `<img>` elements render without `src`
 * until their chunk resolves, and keep none when it fails to load.
 */
import { useEffect, useState } from 'react'
import css from './DesktopOnboarding.module.css'

/** Dynamic import of one artwork module whose default export is its image URL. */
export type OnboardingArtLoader = () => Promise<{ default: string }>

/** Light and dark loaders for one step and locale; module-scoped so their identity is stable across renders. */
export interface OnboardingArtPair {
  /** Artwork shown under the light theme. */
  light: OnboardingArtLoader
  /** Artwork shown under the dark theme. */
  dark: OnboardingArtLoader
}

/** Resolve one loader into a URL, discarding a result that arrives after the pair changed or the step unmounted. */
function useArt(load: OnboardingArtLoader): string | undefined {
  const [art, setArt] = useState<{ load: OnboardingArtLoader; src: string }>()
  useEffect(() => {
    let current = true
    load().then((module) => {
      if (current) setArt({ load, src: module.default })
    }, (_chunkError: unknown) => {
      // A failed artwork chunk keeps this image without a source, the same box it shows while pending.
    })
    return () => { current = false }
  }, [load])
  return art?.load === load ? art.src : undefined
}

/** @param props - artwork loaders and feature-owned geometry. @returns decorative theme variants. */
export function OnboardingIllustration({ className = '', art }: { className?: string | undefined; art: OnboardingArtPair }) {
  const src = useArt(art.light)
  const darkSrc = useArt(art.dark)
  return <div className={`${css.illustration} ${className}`} aria-hidden="true">
    <img className={css.lightIllustration} src={src} alt="" />
    <img className={css.darkIllustration} src={darkSrc} alt="" />
  </div>
}
