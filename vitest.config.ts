import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['plugins/hydra/tests/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true,
  },
});
