// @vitest-environment jsdom
/** Onboarding retains the application's prior inert state and optional title focus. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { OnboardingModal } from '../src/client/OnboardingModal.tsx'

afterEach(cleanup)

it('leaves form focus to the modal when title focus is disabled', () => {
  render(<OnboardingModal title="Setup"><input aria-label="Name" /></OnboardingModal>)
  expect(screen.getByRole('heading', { name: 'Setup' }).hasAttribute('tabindex')).toBe(false)
})
