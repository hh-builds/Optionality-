import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages project site is served under /Optionality-/
export default defineConfig({
  base: '/Optionality-/',
  plugins: [react()],
  build: { outDir: 'dist', target: 'es2018', chunkSizeWarningLimit: 1200 }
});
