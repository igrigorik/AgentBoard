import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/ai-provider.integration.ts'],
    environment: 'node',
    testTimeout: 45_000,
    hookTimeout: 45_000,
    fileParallelism: false,
    bail: 1,
  },
});
