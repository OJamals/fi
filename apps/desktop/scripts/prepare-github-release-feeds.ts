/** Stage validated update metadata for the GitHub release workflow. */

import { readFile } from 'node:fs/promises'
import { prepareGitHubReleaseFeeds } from './github-release-feeds.ts'

const [releasePath, assetDirectory, outputDirectory, ...extra] = process.argv.slice(2)
if (releasePath === undefined || assetDirectory === undefined || outputDirectory === undefined || extra.length !== 0) {
  throw new Error('usage: prepare-github-release-feeds.ts <release.json> <assets-directory> <output-directory>')
}
const result = await prepareGitHubReleaseFeeds(JSON.parse(await readFile(releasePath, 'utf8')), assetDirectory, outputDirectory)
console.log(`fi ${result.version}: ${result.filenames.join(', ')}`)
