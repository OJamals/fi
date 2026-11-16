// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'
import { loadKatex } from '../src/markdown/katex.tsx'

const imports = vi.hoisted(() => ({ count: 0 }))

// The first import fails like a lost chunk; later imports load the real module.
vi.mock('katex', async (importOriginal) => {
  imports.count += 1
  if (imports.count === 1) throw new Error('chunk failed')
  return await importOriginal<typeof import('katex')>()
})

afterEach(cleanup)

it('keeps rendering TeX source when KaTeX fails to load', async () => {
  const view = render(<MarkdownText text="Inline $x^2$." />)
  await expect(loadKatex()).rejects.toThrow(/error when mocking a module/)
  await new Promise(resolve => setTimeout(resolve, 0))

  expect(view.container.querySelector('span[data-tex-pending]')?.textContent).toBe('x^2')
  expect(view.container.querySelector('.katex')).toBeNull()
  expect(imports.count).toBe(1)
})

it('starts a new import on a later formula render after a failed import', async () => {
  const view = render(<MarkdownText text="Inline $y^2$." />)

  await waitFor(() => { expect(view.container.querySelector('.katex')).not.toBeNull() })
  expect(view.container.querySelector('span[data-tex-pending]')).toBeNull()
  expect(imports.count).toBe(2)
})
