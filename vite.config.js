// vite.config.js
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  base: '/', // ← voor subdomeinen!
  plugins: [react()],
  envPrefix: ['VITE_'],
  test: {
    include: ['src/**/*.test.js', 'src/**/*.test.jsx'],
    exclude: ['tests/security/**', 'node_modules/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      components: path.resolve(__dirname, 'src/components'),
      layout: path.resolve(__dirname, 'src/components/layout'),
      shared: path.resolve(__dirname, 'src/components/shared'),
      utils: path.resolve(__dirname, 'src/utils'),
      contexts: path.resolve(__dirname, 'src/contexts'),
      pages: path.resolve(__dirname, 'src/components/pages'),
      services: path.resolve(__dirname, 'src/services'),
      constants: path.resolve(__dirname, 'src/constants'),
      hooks: path.resolve(__dirname, 'src/hooks'),
    },
  },
});
