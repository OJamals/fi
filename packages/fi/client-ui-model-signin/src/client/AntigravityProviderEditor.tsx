/** Native Models-page editor for the Antigravity subscription route. */

import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProviderEditorOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'

import type { SignInFooterInjected } from './SignInFooter.tsx'
import type { SignInStore } from './store.ts'
import styles from './AntigravityProviderEditor.module.css'

/** Credential record the Antigravity adapter family owns. */
const ANTIGRAVITY_CREDENTIAL_KEY = 'fi-antigravity/antigravity'

/** Dependencies injected into the native provider editor. */
export interface AntigravityProviderEditorInjected {
  /** Shared subscription store; it owns grant-aware adoption and recovery. */
  controller: SignInStore
  /** Bound snapshot hook compartment. */
  hooks: { snapshot: SignInStore['store'] }
  /** Subscription sign-in copy. */
  t: SignInFooterInjected['t']
}

/** Props supplied by the Models editor slot. */
export type AntigravityProviderEditorProps =
  & Partial<InjectFace<AntigravityProviderEditorInjected>>
  & ProviderEditorOwnerProps

/** Render the subscription-backed Models setup action. */
export function AntigravityProviderEditor(props: AntigravityProviderEditorProps): ReactNode {
  const { controller, useSnapshot, t } = props
  /* v8 ignore next -- the Models slot binds this component's inject face. */
  if (controller === undefined || useSnapshot === undefined || t === undefined) return null
  return <Bound {...props} controller={controller} useSnapshot={useSnapshot} t={t} />
}

function Bound({ controller, useSnapshot, t, provider, readOnly, onClose }: {
  controller: SignInStore
  useSnapshot: InjectFace<AntigravityProviderEditorInjected>['useSnapshot']
  t: SignInFooterInjected['t']
  provider: ProviderEditorOwnerProps['provider']
  readOnly: boolean
  onClose: (changed: boolean) => void
}): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  const row = state.rows.find(candidate => candidate.key === ANTIGRAVITY_CREDENTIAL_KEY)
  const stored = row?.stored === true
  const busy = state.busy === true || row?.inFlight === true
  const mounted = useRef(true)
  const operation = useRef(0)

  // A slot renderer can retain this component while it supplies another
  // directory row. Both a replacement and unmount invalidate the old action.
  useEffect(() => {
    mounted.current = true
    operation.current += 1
    return () => {
      mounted.current = false
      operation.current += 1
    }
  }, [provider.provider, provider.settingsNs])

  const setup = async (): Promise<void> => {
    const ownOperation = ++operation.current
    await controller.adopt(ANTIGRAVITY_CREDENTIAL_KEY)
    const adopted = controller.store.getSnapshot().adopted
    if (
      mounted.current
      && operation.current === ownOperation
      && adopted?.key === ANTIGRAVITY_CREDENTIAL_KEY
      && adopted.route !== 'skipped'
    ) onClose(true)
  }

  const cancel = (): void => {
    operation.current += 1
    onClose(false)
  }

  return (
    <div className={styles['body']}>
      <p className={styles['hint']}>
        {stored ? t('nativeSetupHint') : t('nativeSetupSignInHint')}
      </p>
      {state.error === null ? null : <p className={styles['error']} role="alert">{state.error}</p>}
      <div className={styles['actions']}>
        <Button
          variant="primary"
          disabled={readOnly || !stored || busy}
          aria-label={t('setupActionFor', { provider: 'Antigravity' })}
          onClick={() => { void setup() }}
        >
          {t('setupAction')}
        </Button>
        <Button variant="ghost" onClick={cancel}>{t('cancel')}</Button>
      </div>
    </div>
  )
}
