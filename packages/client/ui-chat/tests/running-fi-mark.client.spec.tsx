// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RunningFiMark } from '../src/client/chat/RunningFiMark.tsx'

afterEach(cleanup)

it('enables synchronized pulse and dot motion only when reduced motion and forced colors are both inactive', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/client/chat/ChatView.module.css'), 'utf8')
  expect(css.match(/\.runningFiDot\s*\{/g)).toHaveLength(1)
  expect(css).toContain([
    '@media (prefers-reduced-motion: no-preference) and (forced-colors: none) {',
    '  .runningIcon {',
    '    animation: fi-running-pulse 1.5s ease-in-out infinite;',
    '  }',
    '',
    '  .runningFiDot {',
    '    animation: fi-running-dot-lift 1.5s ease-in-out infinite;',
  ].join('\n'))
  expect(css.match(/animation: fi-running-/g)).toHaveLength(2)
  expect(css.slice(css.indexOf('@keyframes fi-running-pulse'), css.indexOf('.openError'))).toMatchSnapshot()
  expect(css).not.toContain('running-whale')
})

it('renders the decorative fi body and separate dot without image requests or focus targets', () => {
  const { container } = render(<RunningFiMark />)
  expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
  expect(container.querySelector('svg')?.getAttribute('focusable')).toBe('false')
  expect(container.querySelector('svg')?.getAttribute('fill')).toBe('currentColor')
  expect(container.querySelectorAll('path')).toHaveLength(2)
  expect(container.querySelector('img, image, animate, [style], [tabindex]')).toBeNull()
  expect(container.innerHTML).toMatchSnapshot()
})
