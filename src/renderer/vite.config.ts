import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: { outDir: '../../out/renderer', emptyOutDir: false },
  test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'], restoreMocks: true }
});
