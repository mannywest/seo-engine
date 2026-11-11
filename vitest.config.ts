import { defineConfig } from 'vitest/config';

// The engine only runs its own tests. The web app (web/) has its own package and its own test run.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
