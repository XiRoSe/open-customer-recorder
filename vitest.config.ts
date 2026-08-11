import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: [],
    include: ['lib/**/*.test.ts', 'app/api/**/*.test.ts'],
    testTimeout: 15000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
});
