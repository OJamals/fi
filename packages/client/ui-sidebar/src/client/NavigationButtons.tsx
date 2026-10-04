/** Shared visited-view controls for the sidebar and hidden-sidebar header. */
import { IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRootInjected } from './contract/slots.ts'
import css from './NavigationButtons.module.css'

/** Callbacks, availability, and localized labels for visited-view navigation. */
export type NavigationButtonsProps = Pick<SidebarRootInjected, 'goBack' | 'goForward'>
  & PropsLocale<'sidebar'>
  & { readonly canGoBack: boolean; readonly canGoForward: boolean }

/**
 * Render Back and Forward with native disabled behavior at history ends.
 * @param props - Navigation callbacks, availability, and sidebar locale.
 * @returns the two navigation buttons.
 */
export function NavigationButtons({ goBack, goForward, canGoBack, canGoForward, t }: NavigationButtonsProps) {
  return <>
    <Tooltip label={t('navigation.back')} delayMs={500} side="bottom">
      <button type="button" className={css.button} aria-label={t('navigation.back')} disabled={!canGoBack} onClick={goBack}>
        <IconChevronLeftOutlineRegular size={16} />
      </button>
    </Tooltip>
    <Tooltip label={t('navigation.forward')} delayMs={500} side="bottom">
      <button type="button" className={css.button} aria-label={t('navigation.forward')} disabled={!canGoForward} onClick={goForward}>
        <IconChevronRightOutlineRegular size={16} />
      </button>
    </Tooltip>
  </>
}
