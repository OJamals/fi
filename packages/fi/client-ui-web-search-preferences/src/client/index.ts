/** Browser half for preferred web-search selection and credential management. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import {
  PreferredSearchCard,
  type PreferredSearchCardProps,
} from './PreferredSearchCard.tsx'
import {
  PreferredSearchCardController,
  credentialRefFor,
  type PreferredSearchCardFace,
  type PreferredSearchCardState,
  type PreferredSearchProvider,
  type PreferredSearchSettings,
  type SubscriptionProvider,
} from './preferred-search-card-controller.ts'
import { en, zh, type PreferredSearchLocaleKey } from './locales.ts'

export type {
  PreferredSearchCardFace,
  PreferredSearchCardProps,
  PreferredSearchCardState,
  PreferredSearchProvider,
  PreferredSearchSettings,
  SubscriptionProvider,
}
export { credentialRefFor, PreferredSearchCard, PreferredSearchCardController }
export type { PreferredSearchLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Preferred web-search card copy. */
    'fi.settings.web-search-preferences': PreferredSearchLocaleKey
  }
}

const NS = 'fi.settings.web-search-preferences'
const SETTINGS_NAMESPACE = 'fi-web-search-preferences'

/** Browser services required by the settings contribution. */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/**
 * Register one FI-owned card in the Plugins page's official-plugin slot,
 * kept live only while the Host serves this preference's namespace.
 * @param ctx - client context supplying settings forms, credentials, locale, and slots.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  const scope = ctx.configForms.get<PreferredSearchSettings>(SETTINGS_NAMESPACE)
  const controller = new PreferredSearchCardController(scope, ctx)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'fi-web-search-preferences: copy dictionaries')
  ctx.effect(() => () => { controller.dispose() }, 'fi-web-search-preferences: card controller')
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { controller.refreshCredential(ref) }),
    'fi-web-search-preferences: credential invalidations',
  )
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NAMESPACE], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: SETTINGS_NAMESPACE,
    order: 50,
    label: () => t('title'),
    locale: NS,
    inject: () => controller.inject(),
  }, PreferredSearchCard))), 'fi-web-search-preferences: card')
}
