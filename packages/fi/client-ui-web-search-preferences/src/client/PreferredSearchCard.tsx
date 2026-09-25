/** Preferred-search card contributed to the configurable Plugins settings tab. */

import { useState } from 'react'
import { IconChevronDownOutline14, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {
  PreferredSearchCardFace,
  PreferredSearchProvider,
  SubscriptionProvider,
} from './preferred-search-card-controller.ts'
import css from './PreferredSearchCard.module.css'

const PROVIDER_OPTIONS = [
  ['deepseek-official', 'deepseek'],
  ['exa', 'exa'],
  ['perplexity', 'perplexity'],
  ['parallel', 'parallel'],
  ['tavily', 'tavily'],
  ['serper', 'serper'],
  ['brave', 'brave'],
  ['subscription-native', 'subscription'],
] as const satisfies readonly (readonly [PreferredSearchProvider, string])[]

const SUBSCRIPTION_OPTIONS = [
  ['codex', 'codex'],
  ['grok', 'grok'],
  ['antigravity', 'antigravity'],
  ['claude', 'claude'],
] as const satisfies readonly (readonly [SubscriptionProvider, string])[]

/** Props supplied by the slot renderer, locale registry, and controller hook face. */
export type PreferredSearchCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'fi.settings.web-search-preferences'>
  & InjectFace<PreferredSearchCardFace>

/**
 * Render provider selection, direct-provider credentials, and subscription handoff.
 * @param props - bound settings scope, credential operations, and localized copy.
 * @returns configurable-plugin card.
 */
export function PreferredSearchCard(props: PreferredSearchCardProps) {
  const state = props.usePreferredSearchCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  if (!state.available && !state.failed) return null
  const unavailable = !state.available
  const title = props.t('title')
  const settingsDisabled = unavailable || !state.writable || state.saving
  const credentialDisabled = unavailable || state.apiKeyChecking || !state.apiKeyWritable || state.saving
  const keyStatus = state.apiKeyChecking ? 'checkingKey' : state.apiKeyConfigured ? 'keySet' : 'keyUnset'
  const saveDisabled = !state.dirty
    || state.invalid
    || unavailable
    || state.saving
    || (state.settingsDirty && !state.writable)
  const toggle = (): void => { setOpen(current => !current) }
  const cardClass = open ? `${css.card} ${css.open}` : css.card

  return (
    <li className={cardClass}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${props.t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={toggle}
      >
        <span className={css.heading}>
          <span className={css.title}>{title}</span>
          <span className={css.description}>{props.t('description')}</span>
        </span>
        {state.dirty ? <Tag tone="neutral">{props.t('unsaved')}</Tag> : null}
        <IconChevronDownOutline14 className={open ? css.chevronOpen : css.chevron} />
      </button>
      {open ? (
        <div className={css.body}>
          {unavailable ? <p role="status" className={css.status}>{props.t('unavailable')}</p> : null}
          {!unavailable && !state.writable
            ? <p role="status" className={css.status}>{props.t('readOnly')}</p>
            : null}
          <label className={css.field} htmlFor="fi-preferred-search-provider">
            <span>{props.t('provider')}</span>
            <select
              id="fi-preferred-search-provider"
              value={state.provider}
              disabled={settingsDisabled}
              onChange={(event) => {
                props.editProvider(event.target.value as typeof state.provider)
              }}
            >
              {PROVIDER_OPTIONS.map(([provider, label]) => (
                <option key={provider} value={provider}>{props.t(label)}</option>
              ))}
            </select>
          </label>
          {state.provider === 'subscription-native' ? (
            <div className={css.group}>
              <label className={css.field} htmlFor="fi-preferred-search-subscription-provider">
                <span>{props.t('subscriptionProvider')}</span>
                <select
                  id="fi-preferred-search-subscription-provider"
                  value={state.subscriptionProvider}
                  disabled={settingsDisabled}
                  onChange={(event) => {
                    props.editSubscriptionProvider(event.target.value as typeof state.subscriptionProvider)
                  }}
                >
                  {SUBSCRIPTION_OPTIONS.map(([provider, label]) => (
                    <option key={provider} value={provider}>{props.t(label)}</option>
                  ))}
                </select>
              </label>
              <label className={css.field} htmlFor="fi-preferred-search-subscription-model">
                <span>{props.t('subscriptionModel')}</span>
                <input
                  id="fi-preferred-search-subscription-model"
                  value={state.subscriptionModel}
                  aria-invalid={state.invalid || undefined}
                  disabled={settingsDisabled}
                  onChange={(event) => { props.editSubscriptionModel(event.target.value) }}
                />
              </label>
              <p className={css.hint}>{props.t('subscriptionHint')}</p>
            </div>
          ) : (
            <div className={css.group}>
              <div className={css.fieldHead}>
                <label htmlFor="fi-preferred-search-api-key">{props.t('apiKey')}</label>
                <Tag tone={state.apiKeyConfigured ? 'neutral' : 'quiet'}>
                  {props.t(keyStatus)}
                </Tag>
              </div>
              <input
                id="fi-preferred-search-api-key"
                type="password"
                autoComplete="off"
                value={state.apiKey}
                placeholder={props.t('updateKey')}
                disabled={credentialDisabled}
                onChange={(event) => { props.editApiKey(event.target.value) }}
              />
              <p className={css.hint}>{props.t('apiKeyHint')}</p>
              {state.apiKeyConfigured && state.apiKeyWritable ? (
                <button type="button" className={css.remove} disabled={credentialDisabled} onClick={props.removeKey}>
                  {props.t('removeKey')}
                </button>
              ) : null}
            </div>
          )}
          <div className={css.footer}>
            {state.failed ? <p role="status" className={css.error}>{props.t('saveFailed')}</p> : null}
            <button type="button" className={css.secondary} disabled={!state.dirty || state.saving} onClick={props.discard}>
              {props.t('discard')}
            </button>
            <button
              type="button"
              className={css.primary}
              disabled={saveDisabled}
              onClick={props.save}
            >
              {props.t(state.saving ? 'saving' : 'save')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
