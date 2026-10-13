import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` (outside Docker) forwards /api calls to a locally running API.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
