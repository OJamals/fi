import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')
  expect(index).toContain('href="./fi-logo.png" media="(prefers-color-scheme: light)"')
  expect(index).toContain('href="./fi-logo-dark-background.png" media="(prefers-color-scheme: dark)"')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  expect(manifest).toEqual({
    name: 'fi',
    short_name: 'fi',
    start_url: './',
    scope: './',
    display: 'fullscreen',
    icons: [{
      src: 'fi-logo.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    }],
  })
})

it('ships both fi PNG artwork variants used by install metadata and browser chrome', async () => {
  const favicon = await readFile(join(DIST_ROOT, 'fi-logo.png'))
  expect(favicon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(favicon.byteLength).toBeGreaterThan(1_000)
  const darkFavicon = await readFile(join(DIST_ROOT, 'fi-logo-dark-background.png'))
  expect(darkFavicon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(darkFavicon.byteLength).toBeGreaterThan(1_000)
})
