import { defineConfig } from 'vite';

// Relative base so the build works on any GitHub Pages path (user or project site).
export default defineConfig({
  base: './',
  build: { target: 'es2020' },
});
