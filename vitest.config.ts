import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts'], exclude: ['tests/e2e/**'], testTimeout: 30000, hookTimeout: 30000, fileParallelism: false } });
