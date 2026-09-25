/**
 * Subscription sign-in plugin, browser half. It adds one OAuth sign-in
 * section to the Models page for the providers whose value is a subscription
 * the user already holds — Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok/X
 * Premium, and Antigravity — and replaces the Antigravity route editor with
 * its subscription-aware setup action.
 *
 * The subscription section remains the only sign-in surface. The native
 * editor can only adopt an existing grant, so it sends an unsigned user to
 * that section instead of opening another OAuth flow.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the Models page's SlotMap merge and editor owner props
// into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// The generated Remote contribution this plugin mounts for itself, and
// type-only the ctx.remote namespace augmentation it brings.
import fiAuthorizationRemote from '@fi/api-authorization-controller/remote'
import { SignInFooter } from './SignInFooter.tsx'
import type { SignInFooterInjected } from './SignInFooter.tsx'
import { AntigravityProviderEditor } from './AntigravityProviderEditor.tsx'
import type { AntigravityProviderEditorInjected } from './AntigravityProviderEditor.tsx'
import { SignInStore, SUBSCRIPTION_PROVIDER_IDS } from './store.ts'
import { en, zh, type SignInKey } from './locales.ts'

export type { SignInFooterInjected, SignInFooterProps } from './SignInFooter.tsx'
export type { SignInAttempt, SignInPrompt, SignInRow, SignInState } from './store.ts'
export type { SignInKey } from './locales.ts'
export { applyFrame, selectOfferedRows, SignInStore } from './store.ts'
export { SUBSCRIPTION_PROVIDER_IDS } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The subscription sign-in card copy. */
    'fi.settings.model-signin': SignInKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'fi.settings.model-signin'

/**
 * Required services (cordis fiber inject). `remote.authorization` is NOT
 * listed here: the application Remote owner's client side mounts only a
 * curated namespace list, so this plugin must mount its own namespace
 * itself. It does so in `apply()` and then enters a scoped fiber that lists
 * the namespace in its inject — the same two-step `client-ui-agent-team`
 * uses, because Cordis refuses `ctx.remote.authorization` property access
 * from any fiber that never declared it.
 */
export const inject = ['slots', 'locale', 'remote']

/**
 * Mount the `authorization` Remote namespace, then in a fiber scoped on it
 * register the sign-in card and keep its flow list fresh on credential
 * invalidations.
 * @param ctx - client root context.
 * @returns disposal of the scoped fiber and the mounted namespace.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  ctx.inject(['modelSubscriptions'], (scope) => {
    scope.effect(
      () => scope.modelSubscriptions.register(SUBSCRIPTION_PROVIDER_IDS),
      'fi-model-signin: subscription model grouping',
    )
  })
  // $mount installs the namespace service synchronously as part of its
  // group before resolving, so the scoped fiber below starts with
  // `remote.authorization` already live rather than parking.
  const disposeRemote = await ctx.remote.$mount(fiAuthorizationRemote)
  const scoped = ctx.inject(['slots', 'locale', 'remote.authorization'], (ctx) => {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'fi-model-signin: copy dictionaries')

    const controller = new SignInStore(ctx)
    const t = ctx.locale.bind(NS) as SignInFooterInjected['t']

    ctx.inject(['modelSettingsSubscriptions'], (scope) => {
      scope.effect(() => {
        let registeredIds: readonly string[] = []
        let disposeRoutes: () => void = () => {}
        const syncRoutes = (): void => {
          const ids = controller.store.getSnapshot().rows.map(row => row.provider)
          if (ids.length === registeredIds.length && ids.every((id, index) => id === registeredIds[index])) return
          disposeRoutes()
          registeredIds = ids
          disposeRoutes = scope.modelSettingsSubscriptions.register(ids)
        }
        const unsubscribe = controller.store.subscribe(syncRoutes)
        syncRoutes()
        return () => { unsubscribe(); disposeRoutes() }
      }, 'fi-model-signin: offered OAuth routes in Models settings')
    })

    // A grant committed anywhere — this card, a second tab, a CLI login —
    // moves the stored state these rows render, and the credential seam
    // announces exactly that. The card's own attempts refresh themselves.
    ctx.effect(() => {
      const refresh = (): void => { void controller.load() }
      const disposers = [
        ctx.remote.$on('credentials/reference-updated', refresh),
        // Grants are records, not references: a revoke — this surface's own,
        // another tab's, a CLI's — announces itself on this event, and
        // without it the section would keep hiding a deleted provider's
        // sign-in button behind the stale stored flag.
        ctx.remote.$on('credentials/record-updated', refresh),
        ctx.on('connection/reset', refresh),
      ]
      return () => {
        controller.dispose()
        for (const dispose of disposers) dispose()
      }
    }, 'fi-model-signin: pushed invalidations')

    // The Models section declares these child slots in its own registration.
    // Registration order is unconstrained, and registering into an
    // undeclared slot throws, so the registrations wait for the declarations
    // through slots.inject() — the same contract the Models page's own apply
    // uses for its parent slots. They re-run if the owner remounts.
    const injected = (): SignInFooterInjected & AntigravityProviderEditorInjected => ({
      controller,
      hooks: { snapshot: controller.store },
      t,
    })
    void controller.load()
    ctx.slots.inject('settings.models.provider-editor', () => ctx.slots.register({
      name: 'settings.models.provider-editor',
      key: 'fi-antigravity',
      inject: injected,
    }, AntigravityProviderEditor))
    ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
      name: 'settings.models.footer',
      id: NS,
      inject: injected,
    }, SignInFooter))
  })
  try {
    await scoped
  } catch (error) {
    await scoped.dispose()
    await disposeRemote()
    throw error
  }
  return async (): Promise<void> => {
    await scoped.dispose()
    await disposeRemote()
  }
}
