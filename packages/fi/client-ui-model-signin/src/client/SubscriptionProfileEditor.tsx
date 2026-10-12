/** Subscription route name and model selection, written through revision-checked settings operations. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LlmDiscoveredModel, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProviderEditorOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { SignInFooterInjected } from './SignInFooter.tsx'
import styles from './AntigravityProviderEditor.module.css'

/** Host operations bound by the subscription plugin; credentials never enter the editor. */
export interface SubscriptionEditorOperations {
  /**
   * Read the settings namespace containing this route.
   * @param ns - settings namespace.
   * @returns effective settings and the revision used for writes.
   */
  read(ns: string): Promise<SettingsNamespaceView>
  /**
   * Discover the complete catalog independently of the saved selection.
   * @param ns - settings namespace.
   * @param provider - provider route id.
   * @returns available models for the stored subscription.
   */
  discover(ns: string, provider: string): Promise<readonly LlmDiscoveredModel[]>
  /**
   * Apply only edited fields against the revision read when opening.
   * @param ns - settings namespace.
   * @param ops - field edits.
   * @param revision - revision read when opening; conflicts reject the write.
   */
  write(ns: string, ops: SettingsPathOpView[], revision: number): Promise<void>
}

/**
 * Render the existing subscription's profile without changing its stored sign-in.
 * @param props - provider address, settings operations, and localized copy.
 * @returns route name and model selection controls.
 */
export function SubscriptionProfileEditor({ provider, readOnly, onClose, operations, t }: ProviderEditorOwnerProps & {
  operations: SubscriptionEditorOperations
  t: SignInFooterInjected['t']
}): ReactNode {
  const [view, setView] = useState<SettingsNamespaceView>()
  const [name, setName] = useState('')
  const [models, setModels] = useState<readonly string[]>()
  const [catalog, setCatalog] = useState<readonly LlmDiscoveredModel[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const active = useRef(true)
  const changed = useRef({ name: false, models: false })
  useEffect(() => {
    let disposed = false
    active.current = true
    void operations.read(provider.settingsNs).then((value) => {
      if (disposed || !active.current) return
      let profile: unknown = value.value
      for (const key of provider.settingsPath) {
        profile = typeof profile === 'object' && profile !== null ? Reflect.get(profile, key) : undefined
      }
      if (typeof profile === 'object' && profile !== null) {
        const displayName: unknown = Reflect.get(profile, 'displayName')
        const selected: unknown = Reflect.get(profile, 'models')
        setName(typeof displayName === 'string' ? displayName : '')
        if (Array.isArray(selected) && selected.every((id): id is string => typeof id === 'string')) setModels(selected)
      }
      setView(value)
    }).catch((failure: unknown) => {
      if (!disposed && active.current) setError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => { disposed = true; active.current = false }
  }, [operations, provider.settingsNs, provider.provider])

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try { await work() } catch (failure: unknown) {
      if (active.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally { if (active.current) setBusy(false) }
  }
  const fetchModels = (): void => { void run(async () => {
    const found = await operations.discover(provider.settingsNs, provider.provider)
    if (!active.current) return
    setCatalog(found)
    if (found.length === 0) setError(t('modelsEmpty'))
  }) }
  const save = (): void => { void run(async () => {
    if (view === undefined) return
    const ops: SettingsPathOpView[] = []
    if (changed.current.name) ops.push(name.trim().length === 0
      ? { op: 'unset', path: [...provider.settingsPath, 'displayName'] }
      : { op: 'set', path: [...provider.settingsPath, 'displayName'], value: name.trim() })
    if (changed.current.models) ops.push(models === undefined
      ? { op: 'unset', path: [...provider.settingsPath, 'models'] }
      : { op: 'set', path: [...provider.settingsPath, 'models'], value: [...models] })
    if (ops.length > 0) await operations.write(provider.settingsNs, ops, view.revision)
    if (active.current) onClose(ops.length > 0)
  }) }
  const disabled = readOnly || busy || view === undefined
  const entries = new Map(catalog.map(model => [model.id, model.name ?? model.id]))
  for (const id of models ?? []) if (!entries.has(id)) entries.set(id, id)
  return <div className={styles['body']}>
    <label className={styles['field']}>
      {t('displayName')}
      <input className={styles['input']} value={name} placeholder={provider.provider} disabled={disabled}
        onChange={(event) => { changed.current.name = true; setName(event.target.value) }} />
    </label>
    <div className={styles['actions']}>
      <Button disabled={busy || view === undefined} onClick={fetchModels}>{t('fetchModels')}</Button>
      <Button disabled={disabled || models === undefined} onClick={() => {
        changed.current.models = true; setModels(undefined)
      }}>{t('allModels')}</Button>
    </div>
    <p className={styles['hint']}>{models === undefined ? t('allModelsHint') : t('selectedModelsHint')}</p>
    <div className={styles['models']}>
      {[...entries].map(([id, label]) => <label key={id} className={styles['model']}>
        <input type="checkbox" aria-label={id === label ? label : `${label} (${id})`}
          checked={models === undefined || models.includes(id)} disabled={disabled}
          onChange={(event) => {
            changed.current.models = true
            const selected = models ?? [...entries.keys()]
            setModels(event.target.checked ? [...selected, id] : selected.filter(value => value !== id))
          }} />
        <span>{label}{id === label ? null : <small>{' '}{id}</small>}</span>
      </label>)}
    </div>
    {error === undefined ? null : <p className={styles['error']} role="alert">{error}</p>}
    <div className={styles['actions']}>
      <Button variant="primary" disabled={disabled} onClick={save}>{t('apply')}</Button>
      <Button variant="ghost" onClick={() => { active.current = false; onClose(false) }}>{t('cancel')}</Button>
    </div>
  </div>
}
