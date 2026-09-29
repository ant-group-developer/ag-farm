import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption } from 'vite';

export default defineConfig({
  // vitest 2 pulls vite 5 in next to the app's vite 6, and a fresh install can type plugin-react against
  // the other copy: the plugin works with both, only its type differs.
  plugins: [react() as unknown as PluginOption],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'antd-vendor': ['antd', '@ant-design/pro-components'],
          'query-vendor': ['@tanstack/react-query'],
          'auth-vendor': ['@auth0/auth0-react'],
        },
      },
    },
  },
  server: {
    port: 5174,
  },
});
