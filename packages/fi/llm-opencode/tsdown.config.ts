import { defineConfig } from 'tsdown'

/** Build the loader plugin from the Host TypeScript artifact. */
export default defineConfig({
  entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node',
  target: 'es2024', fixedExtension: false, dts: false, clean: false,
})
