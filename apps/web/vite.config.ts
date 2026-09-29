import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
