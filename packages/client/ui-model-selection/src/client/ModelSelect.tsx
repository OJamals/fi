/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own pane — the searchable provider-grouped model
 * list over the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * Data and submission ride the SAME per-session ModelDirectory as the
 * /model popup; exact-model reasoning metadata and the selected effort come
 * from the Host rather than a client-owned vocabulary. A rejected selection
 * announces through the shared transient Toast anchored to the composer
 * card; the in-menu strip with Retry remains the catalog-load surface.
 */
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type FocusEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconDataOutline16, IconWarningOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort'

/** Normalize catalog identities for case- and whitespace-insensitive search. */
function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '')
}

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** Stable empty source for direct consumers without a subscription contribution. */
const EMPTY_SUBSCRIPTION_IDS: readonly string[] = []
const EMPTY_SUBSCRIPTIONS = {
  subscribe: (_fn: () => void) => () => {},
  getSnapshot: () => EMPTY_SUBSCRIPTION_IDS,
}

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the root menu or drilled pane.
 */
export function ModelSelect(
  { locked, available, directory, load, select, subscriptionProviders, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const subscriptionStore = subscriptionProviders ?? EMPTY_SUBSCRIPTIONS
  const subscriptionIds = useSyncExternalStore(
    fn => subscriptionStore.subscribe(fn),
    () => subscriptionStore.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [modelQuery, setModelQuery] = useState('')
  const [expandedProviders, setExpandedProviders] = useState<ReadonlySet<string>>(new Set())
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const modelRootRowRef = useRef<HTMLButtonElement | null>(null)
  const effortRootRowRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const paneFocusRef = useRef<'model-search' | 'effort-choice' | 'root-model' | 'root-effort' | null>(null)
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)
  const id = useId()

  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [state.groups])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const busy = state.status === 'selecting'
  const normalizedModelQuery = useMemo(() => normalizeSearch(modelQuery), [modelQuery])
  const searching = normalizedModelQuery.length > 0
  const visibleGroups = useMemo(() => {
    if (!searching) return state.groups.map(group => ({ group, models: group.models }))
    return state.groups.flatMap((group) => {
      const providerMatches = [group.name, group.id]
        .some(value => normalizeSearch(value).includes(normalizedModelQuery))
      const models = providerMatches
        ? group.models
        : group.models.filter(model => [model.name, model.id]
          .some(value => normalizeSearch(value).includes(normalizedModelQuery)))
      return models.length === 0 ? [] : [{ group, models }]
    })
  }, [normalizedModelQuery, searching, state.groups])
  const visibleModelCount = visibleGroups.reduce((total, group) => total + group.models.length, 0)
  const subscriptionIdSet = new Set(subscriptionIds)
  const regularGroups = visibleGroups.filter(({ group }) => !subscriptionIdSet.has(group.id))
  const subscriptionGroups = visibleGroups.filter(({ group }) => subscriptionIdSet.has(group.id))

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card is outside the trigger subtree; check both.
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const target = paneFocusRef.current
    if (target === 'model-search' && pane === 'model') searchRef.current?.focus()
    else if (target === 'effort-choice' && pane === 'effort') {
      const choices = menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-model-menu-nav="true"]:not(:disabled)')
      const selected = menuRef.current?.querySelector<HTMLButtonElement>(
        '[role="menuitemradio"][aria-checked="true"]:not(:disabled)',
      )
      const choice = selected ?? choices?.[0]
      ;(choice ?? menuRef.current)?.focus()
    }
    else if (target === 'root-model' && pane === 'root') modelRootRowRef.current?.focus()
    else if (target === 'root-effort' && pane === 'root') effortRootRowRef.current?.focus()
    else return
    paneFocusRef.current = null
  }, [open, pane])

  // Portaled placement (the Menu primitive's portal rules: fixed from the
  // anchor rect, measured before paint, clamped inside the viewport): above
  // the trigger, right edges aligned. Depends on pane and directory state
  // because pane switches and async catalog loads resize the card.
  /* jscpd:ignore-start -- deliberate mirror of ui-primitives useAnchoredPosition:
     that hook only places from the anchor's LEFT edge, while this card aligns
     right edges (x = rect.right - width), so the measure-and-clamp plumbing repeats. */
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return }
    const place = (): void => {
      /* v8 ignore next 2 -- the trigger ref is attached whenever the menu is open. */
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = menuRef.current?.offsetWidth ?? 0
      const lh = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      setMenuPos({ left: x, top: y })
    }
    // First run measures the hidden pre-render (same commit as `open`), so
    // the card lands placed before anything paints.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [expandedProviders, modelQuery, open, pane, state])
  /* jscpd:ignore-end */

  if (!available) return null

  const show = (): void => {
    setPane('root')
    setModelQuery('')
    setExpandedProviders(new Set())
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    paneFocusRef.current = null
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (move: -1 | 1 | 'first' | 'last'): void => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
      '[data-model-menu-nav="true"]:not(:disabled)',
    ) ?? [])]
    if (items.length === 0) return
    if (move === 'first' || move === 'last') {
      items[move === 'first' ? 0 : items.length - 1]?.focus()
      return
    }
    const active = items.findIndex(item => item === document.activeElement)
    const next = active < 0
      ? (move === 1 ? 0 : items.length - 1)
      : (active + move + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape backs out of a drilled pane first, then closes.
      if (pane !== 'root') {
        paneFocusRef.current = pane === 'model' ? 'root-model' : 'root-effort'
        setPane('root')
      } else close(true)
      return
    }
    if (!open) return
    if (event.target === searchRef.current && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      moveFocus(event.key === 'Home' ? 'first' : 'last')
    }
  }

  const toggleProvider = (provider: string): void => {
    setExpandedProviders((current) => {
      const next = new Set(current)
      if (!next.delete(provider)) next.add(provider)
      return next
    })
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const waiting = state.current === null && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? (state.current === null ? t('trigger.fallback') : `${state.current.provider}/${state.current.model}`)
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : state.current === null
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  const renderGroup = ({ group, models }: typeof visibleGroups[number], groupIndex: number) => {
    const headingId = `${id}-provider-${String(groupIndex)}`
    const modelsId = `${headingId}-models`
    const expanded = searching || expandedProviders.has(group.id)
    return (
      <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
        <button
          id={headingId}
          type="button"
          role="menuitem"
          data-model-menu-nav="true"
          className={css.groupTitle}
          aria-expanded={expanded}
          aria-controls={expanded ? modelsId : undefined}
          disabled={searching}
          onClick={(event) => {
            event.currentTarget.focus()
            toggleProvider(group.id)
          }}
        >
          <IconChevronRightOutline14
            className={clsx(css.groupChevron, expanded && css.groupChevronOpen)}
            aria-hidden="true"
          />
          <span>{group.name}</span>
        </button>
        {expanded && (
          <div className={css.groupModels} id={modelsId}>
            {models.map((model) => {
              const selected = state.current?.provider === group.id && state.current.model === model.id
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  data-model-menu-nav="true"
                  aria-checked={selected}
                  className={clsx(css.option, selected && css.selected)}
                  key={model.id}
                  title={model.name}
                  disabled={busy}
                  onClick={() => { choose({ provider: group.id, model: model.id }) }}
                >
                  <span className={css.optionCopy}>
                    <span className={css.modelName}>{model.name}</span>
                  </span>
                  <span className={css.check}>
                    {selected ? <IconCheckOutline16 /> : null}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </section>
    )
  }
  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup={pane === 'model' ? 'dialog' : 'menu'}
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        <IconDataOutline16 className={css.triggerIcon} size={16} />
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {/* Portaled to body (Menu primitive's portal mode) so the sidebar and
          column overflow clips cannot crop the card; synthetic events still
          bubble through this React subtree, keeping onKeyDown/onBlur live. */}
      {open && createPortal(
        <div
          ref={menuRef}
          id={`${id}-menu`}
          className={css.menu}
          style={menuPos ?? MEASURE_STYLE}
          role={pane === 'model' ? 'dialog' : 'menu'}
          tabIndex={-1}
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'root' && (
            <>
              <button
                ref={modelRootRowRef}
                type="button"
                role="menuitem"
                data-model-menu-nav="true"
                className={css.cell}
                onClick={() => {
                  paneFocusRef.current = 'model-search'
                  setPane('model')
                }}
              >
                <span className={css.cellLabel}>{t('menu.model')}</span>
                <span className={css.cellValue}>{modelLabel}</span>
                <IconChevronRightOutline14 className={css.cellChevron} />
              </button>
              {reasoning !== undefined && (
                <button
                  ref={effortRootRowRef}
                  type="button"
                  role="menuitem"
                  data-model-menu-nav="true"
                  className={css.cell}
                  onClick={() => {
                    paneFocusRef.current = 'effort-choice'
                    setPane('effort')
                  }}
                >
                  <span className={css.cellLabel}>{t('menu.effort')}</span>
                  <span className={css.cellValue}>{effortLabel}</span>
                  <IconChevronRightOutline14 className={css.cellChevron} />
                </button>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              <div className={css.search} role="search">
                <input
                  ref={searchRef}
                  type="search"
                  name="model-search"
                  className={css.searchInput}
                  value={modelQuery}
                  placeholder={t('search.models')}
                  aria-label={t('search.models')}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => { setModelQuery(event.currentTarget.value) }}
                />
              </div>
              {state.status === 'loading' && (
                <div className={css.status}>{t('status.loading')}</div>
              )}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div
                className={clsx(css.groups, 'scrollable')}
                role="menu"
                aria-label={t('menu.model')}
              >
                {regularGroups.map(renderGroup)}
                {subscriptionGroups.length > 0 && (
                  <section role="group" aria-label={t('group.subscriptions')} className={css.subscriptionSection}>
                    <div className={css.subscriptionHeading} aria-hidden="true">{t('group.subscriptions')}</div>
                    {subscriptionGroups.map((entry, index) => renderGroup(entry, regularGroups.length + index))}
                  </section>
                )}
              </div>
              {state.status === 'ready' && !searching && choices.length === 0 && (
                <div className={css.empty}>{t('empty.models')}</div>
              )}
              {state.status === 'ready' && searching && visibleModelCount === 0 && (
                <div className={css.empty} role="status">{t('empty.search')}</div>
              )}
            </>
          )}

          {pane === 'effort' && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    type="button"
                    role="menuitemradio"
                    data-model-menu-nav="true"
                    aria-checked={effectiveEffort === level.effort}
                    className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
                    key={level.key}
                    disabled={busy}
                    onClick={() => { chooseEffort(level.effort) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{level.label}</span>
                    </span>
                    <span className={css.check}>
                      {effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}
                    </span>
                  </button>
                ))}
            </>
          )}
        </div>,
        document.body,
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
