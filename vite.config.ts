import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// GitHub Pages serves this repo from a subpath: https://<user>.github.io/40k-battle-simulator/
// `base` must match the repo name so built asset URLs resolve. Override with BASE_PATH if the
// repo is ever renamed or served from a custom domain.
const base = process.env.BASE_PATH ?? '/40k-battle-simulator/';

export default defineConfig({
  base,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './tests/setup.ts',
    // Pure-core + geometry tests live in tests/; co-located UI tests use *.test.tsx
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
  },
});
