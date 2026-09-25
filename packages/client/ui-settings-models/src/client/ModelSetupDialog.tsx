/**
 * Model-universal first-run step. Readiness comes from the same
 * provider/settings/credential join as the Models page: any provider the user
 * can already talk to ends the step, and only a user with none is asked to
 * set a model up. No provider is presumed — the step routes to the Models
 * page, where every provider is configured, instead of collecting any one
 * vendor's credential.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelsSettingsState, ModelsSettingsStore } from './store.ts'
import { onboardingReadiness } from './store.ts'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import { OnboardingModal } from './OnboardingModal.tsx'
import css from './ModelSetupDialog.module.css'

/** Registration-side dependencies of {@link ModelSetupDialog}. */
export interface ModelSetupDialogInjected {
  /** Whether first-run setup should show automatically; false leaves it to a native shell's own onboarding. */
  automatic: boolean
  hooks: {
    /** Shared Models-page join state, bound by the slot renderer. */
    models: SnapshotStore<ModelsSettingsState>
  }
  /** Shared Models-page join controller. */
  controller: ModelsSettingsStore
  /** Feature copy. */
  t: (key: keyof typeof en) => string
}

/** Slot owner props plus the feature's injected dependencies. */
export type ModelSetupDialogProps =
  PropsRuntime<'settings.onboarding'> & InjectFace<ModelSetupDialogInjected>

/**
 * Prompt a first-run user without any usable provider to set a model up, by
 * routing them to the Models page.
 * @param props - settings-shell owner state and Models feature dependencies.
 * @returns the onboarding modal or null when onboarding needs no intervention.
 */
export function ModelSetupDialog(props: ModelSetupDialogProps): ReactNode {
  const { complete, openSection, controller, useModels, t, automatic } = props
  const state = useModels(snapshot => snapshot)
  const readiness = onboardingReadiness(state)

  useEffect(() => {
    if (automatic && state.status === 'idle') void controller.load()
  }, [automatic, controller, state.status])

  useEffect(() => {
    if (
      !automatic
      || readiness.kind === 'no-providers'
      || readiness.kind === 'provider-ready'
      || readiness.kind === 'unavailable'
    ) complete()
  }, [automatic, complete, readiness.kind])

  if (!automatic || readiness.kind !== 'model-unconfigured') return null

  const chooseModel = (): void => {
    complete()
    openSection('models')
  }

  return (
    <OnboardingModal title={t('onboardingTitle')} focusTitle>
      <p className={css.description}>{t('onboardingDescription')}</p>
      <div className={css.actions}>
        <Button variant="primary" className={css.primary} onClick={chooseModel}>
          {t('onboardingChoose')}
        </Button>
        <Button onClick={() => { complete() }}>{t('onboardingLater')}</Button>
      </div>
    </OnboardingModal>
  )
}
