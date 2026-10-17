/** Source-launched installation contender for the cross-process filesystem test. */
import { writeFile } from 'node:fs/promises'
import { installPrimaryRuntime } from '../../src/index.ts'

const [source, root, marker] = process.argv.slice(2)
if (!source || !root || !marker) throw new Error('installation fixture requires source, root, and marker')
await writeFile(marker, 'ready')
await installPrimaryRuntime(source, root)
process.stdout.write('installed\n')
