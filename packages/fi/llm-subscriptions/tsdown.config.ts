import { defineConfig } from 'tsdown'

/** Bundle the Host plugin after TypeScript emits its implementation. */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: ['lib/*.js'],
  deps: { alwaysBundle: [/^gpt-tokenizer(?:\/|$)/u] },
  copy: [{ from: 'node_modules/gpt-tokenizer/LICENSE', to: 'lib/licenses/gpt-tokenizer' }],
})
