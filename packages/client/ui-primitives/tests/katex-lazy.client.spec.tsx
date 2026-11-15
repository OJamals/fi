// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'
import { loadKatex } from '../src/markdown/katex.tsx'

afterEach(cleanup)

it('renders TeX source until KaTeX loads, then replaces it with the KaTeX tree', async () => {
  const view = render(<MarkdownText text={'Inline $x^2$.\n\n$$\na + b\n$$'} />)
  const pending = [...view.container.querySelectorAll('span[data-tex-pending]')].map(span => span.textContent)
  expect(pending).toEqual(['x^2', 'a + b'])
  expect(view.container.querySelector('.katex')).toBeNull()

  await waitFor(() => { expect(view.container.querySelectorAll('.katex')).toHaveLength(2) })
  expect(view.container.querySelector('span[data-tex-pending]')).toBeNull()
  expect(view.container.querySelectorAll('.katex-display')).toHaveLength(1)

  const later = render(<MarkdownText text="Later $y$." />)
  expect(later.container.querySelector('span[data-tex-pending]')).toBeNull()
  expect(later.container.querySelector('.katex annotation')?.textContent).toBe('y')
  expect(loadKatex()).toBe(loadKatex())
})
