// Pixel-diff helpers for the opt-in visual-baseline lane
// (gui-surfaces.visual.ts). PNGs decode through pngjs and diff through
// pixelmatch; DSH_SNAPSHOT reuses the vitest e2e lane's replay/refresh
// vocabulary (scaffold.ts's webSnapshotMode) so recording a baseline uses
// the same envelope contributors already know from the aria-golden lane.
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import type { WebSnapshotMode } from '../tests/scaffold.ts'

/**
 * Fraction of an image's pixels a diff may cover before the lane fails.
 * Headless Chromium rasterizes in software (unlike a live GPU-composited
 * window), so run-to-run noise is normally exactly zero; this absorbs a
 * handful of stray pixels from anti-aliasing/sub-pixel text-metric drift
 * without hiding a real regression, which moves thousands of pixels.
 */
const MAX_DIFF_PIXEL_RATIO = 0.0005

/** Per-pixel color-distance threshold pixelmatch treats as "different" (its own 0-1 scale). */
const PIXELMATCH_THRESHOLD = 0.1

export interface PixelBaselineResult {
  /** Whether the actual capture matched the committed baseline within tolerance. */
  matched: boolean
  /** Diff pixel count from pixelmatch; the larger image's pixel count on a dimension mismatch. */
  diffPixels: number
  /** Total pixels compared; 0 when the mode wrote a fresh baseline instead of comparing. */
  totalPixels: number
  /** PNG bytes visualizing the diff, for failure evidence; absent on a dimension mismatch or a match. */
  diffPng?: Buffer
}

/**
 * Compare a PNG capture with its committed baseline, or write it under
 * DSH_SNAPSHOT=refresh. Refresh is the ONLY writer, matching the vitest
 * lane's compareOrRefreshGolden: a missing baseline in replay mode fails
 * with the healing command instead of silently self-bootstrapping.
 * @param baselinePath - committed baseline PNG path.
 * @param actualPng - the capture just taken, as PNG bytes.
 * @param mode - the active snapshot mode ('record' behaves like 'refresh': pixels have no live-provider distinction).
 * @returns the comparison result; `matched` is always true after a refresh/record write.
 */
export async function compareOrRecordPixelBaseline(
  baselinePath: string, actualPng: Buffer, mode: WebSnapshotMode,
): Promise<PixelBaselineResult> {
  if (mode === 'refresh' || mode === 'record') {
    await mkdir(dirname(baselinePath), { recursive: true })
    await writeFile(baselinePath, actualPng)
    return { matched: true, diffPixels: 0, totalPixels: 0 }
  }
  if (!existsSync(baselinePath)) {
    throw new Error(`missing pixel baseline ${baselinePath} — run DSH_SNAPSHOT=refresh pnpm run test:web:visual to record it`)
  }
  const baseline = PNG.sync.read(await readFile(baselinePath))
  const actual = PNG.sync.read(actualPng)
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    const pixels = Math.max(baseline.width * baseline.height, actual.width * actual.height)
    return { matched: false, diffPixels: pixels, totalPixels: pixels }
  }
  const { width, height } = baseline
  const diff = new PNG({ width, height })
  const diffPixels = pixelmatch(baseline.data, actual.data, diff.data, width, height, { threshold: PIXELMATCH_THRESHOLD })
  const totalPixels = width * height
  return {
    matched: diffPixels / totalPixels <= MAX_DIFF_PIXEL_RATIO,
    diffPixels,
    totalPixels,
    diffPng: PNG.sync.write(diff),
  }
}
