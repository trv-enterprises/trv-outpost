// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Vitest config for client component tests (introduced with the #248
// store-picker regression test). Kept separate from vite.config.js so the
// dev/build pipeline is untouched. jsdom environment because these are
// render tests; heavy leaves (echarts, apiClient) are mocked per-test.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    // Carbon imports SCSS in some entry points; treat CSS as no-ops.
    css: false,
  },
});
