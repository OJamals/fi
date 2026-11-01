/** Built-artifact checks; run after the package bundle has been generated. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, copyFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { encode, decode } from 'gpt-tokenizer/encoding/o200k_base'

test('the private offline tokenizer preserves encoding without its npm package', async () => {
  const root = new URL('../', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(manifest.dependencies['gpt-tokenizer'], undefined)
  assert.equal(manifest.devDependencies['gpt-tokenizer'], '^3.4.0')
  assert.ok(manifest.files.includes('lib/*.js'))
  assert.ok(manifest.files.includes('lib/licenses/**'))
  const entry = await readFile(new URL('lib/index.js', root), 'utf8')
  const chunk = entry.match(/import\("(\.\/o200k_base-[^"/]+\.js)"\)/u)?.[1]
  assert.ok(chunk, 'budget tokenizer stays a local dynamic import')
  assert.deepEqual((await readdir(new URL('lib/', root))).filter(name => name.endsWith('.js')).sort(), ['index.js', chunk.slice(2)].sort())
  assert.doesNotMatch(entry, /from ["']gpt-tokenizer|import\(["']gpt-tokenizer/u)
  const bundled = new URL(chunk, new URL('lib/index.js', root))
  assert.ok((await stat(bundled)).size < 3 * 1024 * 1024, 'only one vocabulary is bundled')
  assert.equal(
    await readFile(new URL('lib/licenses/gpt-tokenizer/LICENSE', root), 'utf8'),
    await readFile(new URL('node_modules/gpt-tokenizer/LICENSE', root), 'utf8'),
  )
  const isolated = await mkdtemp(join(tmpdir(), 'fi-tokenizer-'))
  try {
    const target = join(isolated, 'tokenizer.mjs')
    await copyFile(bundled, target)
    const actual = await import(pathToFileURL(target).href)
    actual.setMergeCacheSize(1000)
    // The incremental output budget reads the pretokenizer regex and the shared streaming decoder.
    assert.ok(actual.O200K_TOKEN_SPLIT_REGEX instanceof RegExp)
    assert.equal(typeof actual.decoder.decode, 'function')
    const options = { disallowedSpecial: new Set() }
    for (const input of ['', 'hello world', '中文 العربية', '🧑🏽‍⚕️ café', '<|endoftext|>', '{"path":"/tmp/fi","value":42}']) {
      const expected = encode(input, options)
      assert.deepEqual(actual.encode(input, options), expected)
      assert.equal(actual.decode(expected), decode(expected))
    }
  } finally {
    await rm(isolated, { recursive: true, force: true })
  }
})
