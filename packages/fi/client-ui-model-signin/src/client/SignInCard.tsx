/**
 * The attempt conversation view shared by this package's sign-in surfaces:
 * notices (the URL to open, the device code to type), the live prompt form,
 * and the settled outcome. It is its own module because the footer's
 * subscription section renders it below the provider list while an earlier
 * revision rendered it inside per-row cards — the conversation component is
 * identical either way, and keeping it here keeps that history visible.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SignInAttempt, SignInStore } from './store.ts'
import type { en } from './locales.ts'
import styles from './SignInCard.module.css'

/** Injected dependencies of {@link SignInCard} (slot `inject`). */
export interface SignInCardInjected {
  /** The card store (loaded on mount, refreshed after every attempt). */
  controller: SignInStore
  hooks: {
    /** Card snapshot bound by the UI renderer as useSnapshot. */
    signIn: SignInStore['store']
  }
  /** Card copy. */
  t: (key: keyof typeof en, params?: Record<string, string>) => string
}

/** The question form, which owns its own draft so a keystroke never re-renders the page. */
function PromptForm({ attempt, controller, t }: {
  attempt: SignInAttempt
  controller: SignInStore
  t: SignInCardInjected['t']
}): ReactNode {
  const [draft, setDraft] = useState('')
  const prompt = attempt.prompt
  if (prompt === null) return null
  if (prompt.kind === 'select') {
    return (
      <div className={styles['prompt']}>
        <p className={styles['promptMessage']}>{prompt.message}</p>
        <div className={styles['promptOptions']}>
          {(prompt.options ?? []).map(option => (
            <Button
              key={option.id}
              variant="outline"
              onClick={() => { void controller.answer(option.id) }}
              title={option.description ?? option.label}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <form
      className={styles['prompt']}
      onSubmit={(event) => {
        event.preventDefault()
        if (draft === '') return
        // The draft leaves with the answer and is dropped: a pasted OAuth
        // code is a bearer secret for as long as it is live, and this card is
        // not its store.
        void controller.answer(draft)
        setDraft('')
      }}
    >
      <p className={styles['promptMessage']}>{prompt.message}</p>
      <div className={styles['promptRow']}>
        <Input
          value={draft}
          type={prompt.kind === 'secret' ? 'password' : 'text'}
          placeholder={prompt.placeholder ?? ''}
          aria-label={prompt.message}
          autoComplete="off"
          onChange={(event) => { setDraft(event.currentTarget.value) }}
        />
        <Button variant="primary" type="submit" disabled={draft === ''}>{t('submit')}</Button>
      </div>
    </form>
  )
}

/** The live conversation of one running attempt. */
export function AttemptView({ attempt, controller, t }: {
  attempt: SignInAttempt
  controller: SignInStore
  t: SignInCardInjected['t']
}): ReactNode {
  if (attempt.settled !== null) {
    const { status, message, route } = attempt.settled
    const provider = attempt.key.slice(attempt.key.indexOf('/') + 1)
    return (
      <div className={styles['attempt']} role="status">
        <p className={styles['settled']}>
          {status === 'authorized'
            ? route === 'created'
              ? t('signedInRouteCreated', { provider })
              : route === 'already' ? t('signedInRouteAlready', { provider }) : t('signedIn')
            : status === 'cancelled' ? t('cancelled') : message ?? t('failed')}
        </p>
        <Button variant="ghost" onClick={() => { controller.dismiss() }}>{t('close')}</Button>
      </div>
    )
  }
  return (
    <div className={styles['attempt']}>
      {attempt.notice === null
        ? <p className={styles['notice']} role="status">{t('starting')}</p>
        : (
          <div className={styles['notice']} role="status">
            <p className={styles['noticeMessage']}>{attempt.notice.message}</p>
            {attempt.notice.url === undefined
              ? null
              : (
                <a
                  className={styles['noticeLink']}
                  href={attempt.notice.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {attempt.notice.url}
                </a>
              )}
            {attempt.notice.code === undefined
              ? null
              : <p className={styles['noticeCode']}><code>{attempt.notice.code}</code></p>}
          </div>
        )}
      <PromptForm attempt={attempt} controller={controller} t={t} />
      <Button variant="ghost" onClick={() => { controller.dismiss() }}>{t('cancel')}</Button>
    </div>
  )
}
