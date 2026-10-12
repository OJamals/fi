// @vitest-environment jsdom
/** A retained menu measurement callback stops exposing a pointer after dismissal. */
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { ProjectRowItem } from '../src/client/rows/Rows.tsx'
import { en } from '../src/client/locales.ts'

const measurement = vi.hoisted(() => ({ current: undefined as (() => DOMRect | null) | undefined }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const primitives = await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>()
  return { ...primitives, Menu(props: ComponentProps<typeof primitives.Menu>) {
    if (props.getAnchorRect !== undefined) measurement.current = props.getAnchorRect
    return <primitives.Menu {...props} />
  } }
})
afterEach(() => { cleanup(); measurement.current = undefined })

it('returns null from an old pointer anchor after the menu closes', () => {
  render(<ProjectRowItem group={{
    key: 'project', workspaceId: 'project' as WorkspaceId, cwd: '/project', label: 'Project',
    createdAt: 0, sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
  }} onToggle={() => {}} onCreate={() => {}}
  actions={{ rename: () => {}, delete: () => {}, manageWorktree: () => {} }} t={makeTranslate(en, commonEn)} />)
  fireEvent.contextMenu(screen.getByRole('treeitem'), { clientX: 120, clientY: 88 })
  const anchor = measurement.current
  expect(anchor?.()).toMatchObject({ x: 120, y: 88 })
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(anchor?.()).toBeNull()
})
