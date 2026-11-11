import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { defineConfig } from 'vitest/config';

// One self-contained page: easy to host anywhere (Cloudflare Pages) and easy to preview.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
