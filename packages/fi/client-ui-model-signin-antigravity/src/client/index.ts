/**
 * Antigravity sign-in plugin, browser half. It adds OAuth sign-in to the
 * Models page for Antigravity by registering into the Models section's
 * `settings.models.footer` extension slot.
 *
 * The Models section is not modified: the slot exists precisely so a plugin
 * can add to the page from outside. Unlike the pi-ai card, this one only
 * uses the footer — Antigravity is not in pi-ai's catalog, so there are no
 * pi-ai provider cards to extend.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the Models page's SlotMap merge (the footer slot)
// and its owner-props declaration into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
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
import { SignInStore } from './store.ts'
import { en, zh, type SignInKey } from './locales.ts'

export type { SignInFooterInjected, SignInFooterProps } from './SignInFooter.tsx'
export type { SignInAttempt, SignInPrompt, SignInState } from './store.ts'
export type { SignInKey } from './locales.ts'
export { SignInStore } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Antigravity sign-in card copy. */
    'fi.settings.model-signin-antigravity': SignInKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'fi.settings.model-signin-antigravity'

/**
 * Required services (cordis fiber inject). `remote.authorization` is NOT
 * listed here: the application Remote owner's client side mounts only a
 * curated namespace list, so this plugin must mount its own namespace
 * itself. It does so in `apply()` and then enters a scoped fiber that lists
 * the namespace in its inject — the same two-step the pi-ai sign-in card
 * uses, because Cordis refuses `ctx.remote.authorization` property access
 * from any fiber that never declared it.
 */
export const inject = ['slots', 'locale', 'remote']

/**
 * Mount the `authorization` Remote namespace, then in a fiber scoped on it
 * register the Antigravity footer card and keep its state fresh on credential
 * invalidations.
 * @param ctx - client root context.
 * @returns disposal of the scoped fiber and the mounted namespace.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  // $mount installs the namespace service synchronously as part of its
  // group before resolving, so the scoped fiber below starts with
  // `remote.authorization` already live rather than parking.
  const disposeRemote = await ctx.remote.$mount(fiAuthorizationRemote)
  const scoped = ctx.inject(['slots', 'locale', 'remote.authorization'], (ctx) => {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'fi-model-signin-antigravity: copy dictionaries')

    const controller = new SignInStore(ctx)
    const t = ctx.locale.bind(NS) as SignInFooterInjected['t']
    const injectedFooter = (): SignInFooterInjected => ({
      controller,
      hooks: { snapshot: controller.store },
      t,
    })

    // A grant committed anywhere — this card, a second tab, a CLI login —
    // moves the stored state this row renders, and the credential seam
    // announces exactly that. The card's own attempts refresh themselves.
    ctx.effect(() => {
      const refresh = (): void => { void controller.load() }
      const disposers = [
        ctx.remote.$on('credentials/reference-updated', refresh),
        ctx.on('connection/reset', refresh),
      ]
      return () => {
        controller.dispose()
        for (const dispose of disposers) dispose()
      }
    }, 'fi-model-signin-antigravity: pushed invalidations')

    // The Models section declares this child slot in its own registration.
    // Registration order is unconstrained, and registering into an
    // undeclared slot throws, so the registration waits for the declaration
    // through slots.inject() — the same contract the pi-ai card uses.
    void controller.load()
    ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
      name: 'settings.models.footer',
      id: NS,
      inject: injectedFooter,
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
