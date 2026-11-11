import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from './core/version.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    rollupOptions: { input: { workbench: path.join(root, 'renderer/index.html'), preview: path.join(root, 'preview/index.html') } },
  },
});
