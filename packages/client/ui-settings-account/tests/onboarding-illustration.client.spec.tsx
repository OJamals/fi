// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OnboardingIllustration, type OnboardingArtLoader, type OnboardingArtPair } from '../src/client/OnboardingIllustration.tsx'

afterEach(() => { cleanup() })

/** A loader whose module settles only when the test resolves it. */
function deferredArt(src: string): { load: OnboardingArtLoader; resolve: () => Promise<void> } {
  let settle: (module: { default: string }) => void = () => {}
  const pending = new Promise<{ default: string }>((resolve) => { settle = resolve })
  return {
    load: () => pending,
    resolve: async () => { await act(async () => { settle({ default: src }); await pending }) },
  }
}

function images(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('img')].map(image => image.getAttribute('src'))
}

it('renders both theme images without a source until each artwork chunk resolves', async () => {
  const light = deferredArt('light.webp')
  const dark = deferredArt('dark.webp')
  const view = render(<OnboardingIllustration art={{ light: light.load, dark: dark.load }} />)
  expect(images(view.container)).toEqual([null, null])
  await light.resolve()
  expect(images(view.container)).toEqual(['light.webp', null])
  await dark.resolve()
  expect(images(view.container)).toEqual(['light.webp', 'dark.webp'])
})

it('leaves a theme image without a source when its artwork chunk fails to load', async () => {
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  try {
    const light = deferredArt('light.webp')
    let reject: (error: Error) => void = () => {}
    const failed = new Promise<{ default: string }>((_resolve, fail) => { reject = fail })
    const view = render(<OnboardingIllustration art={{ light: light.load, dark: () => failed }} />)
    await act(async () => {
      reject(new Error('chunk failed'))
      await failed.catch(() => undefined)
    })
    await light.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(images(view.container)).toEqual(['light.webp', null])
    expect(view.container.querySelectorAll('img')).toHaveLength(2)
    expect(unhandled).not.toHaveBeenCalled()
  } finally {
    process.off('unhandledRejection', unhandled)
  }
})

it('drops artwork that resolves after the pair changed or the step unmounted', async () => {
  const stale = deferredArt('stale.webp')
  const fresh = deferredArt('fresh.webp')
  const first: OnboardingArtPair = { light: stale.load, dark: stale.load }
  const second: OnboardingArtPair = { light: fresh.load, dark: fresh.load }
  const view = render(<OnboardingIllustration art={first} />)
  view.rerender(<OnboardingIllustration art={second} />)
  await stale.resolve()
  expect(images(view.container)).toEqual([null, null])
  await fresh.resolve()
  expect(images(view.container)).toEqual(['fresh.webp', 'fresh.webp'])
  view.rerender(<OnboardingIllustration art={first} />)
  expect(images(view.container)).toEqual([null, null])
  view.unmount()
})
