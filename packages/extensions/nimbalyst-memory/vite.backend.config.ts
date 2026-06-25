import { defineConfig } from 'vite';
import { resolve } from 'path';

// Backend module bundle. Runs in an Electron utility-process (Node), loaded by
// the host's extensionBackendBootstrap via dynamic import.
//
// The engine (../engine/dist) is BUNDLED IN (relative import) so the utility
// process needs no @nimbalyst/memory-engine resolution. Its native + heavy deps
// stay EXTERNAL so they load from the hoisted root node_modules at runtime:
//   - better-sqlite3 is a native module (must not be bundled)
//   - fast-glob / chokidar / js-yaml / picomatch are Node-only
//   - @huggingface/transformers is an optional local-embedder dep (unused in
//     the OpenAI-only v1; externalized so it never bundles)
export default defineConfig({
  mode: 'production',
  build: {
    lib: {
      entry: resolve(__dirname, 'src/backend.ts'),
      formats: ['es'],
      fileName: () => 'backend.js',
    },
    rollupOptions: {
      external: [
        /^node:/,
        'better-sqlite3',
        'fast-glob',
        'chokidar',
        'js-yaml',
        'picomatch',
        '@huggingface/transformers',
        /^@nimbalyst\//,
      ],
      output: { inlineDynamicImports: true },
    },
    target: 'node18',
    outDir: 'dist',
    // Do NOT wipe dist — the shell build (vite.config.ts) emits index.js here.
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
  },
});
