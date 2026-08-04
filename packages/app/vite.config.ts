import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  // Loaded over file:// from the packaged app, so asset URLs must be relative.
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
});
