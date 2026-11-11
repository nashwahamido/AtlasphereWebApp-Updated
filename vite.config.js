import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  // The bundle is served from /dist/, so lazily loaded chunks and the images
  // CSS refers to (e.g. Leaflet's) are linked relative to it.
  experimental: {
    renderBuiltUrl() { return { relative: true }; },
  },
  build: {
    outDir: 'public/dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        groupTabs: path.resolve(__dirname, 'client/src/groupTabs.jsx'),
        activities: path.resolve(__dirname, 'client/activities.jsx'),
        crowdMap: path.resolve(__dirname, 'client/crowd-map.js'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});