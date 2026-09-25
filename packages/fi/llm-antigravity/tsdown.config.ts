import { defineConfig } from 'tsdown'

const common = {
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    alwaysBundle: ['@fi/provider-compat'],
  },
}

/** Build the plugin root and native transport as independent plain-Node artifacts. */
export default defineConfig([
  { ...common, entry: ['lib/types/index.js'] },
  { ...common, entry: ['lib/types/transport.js'] },
])
