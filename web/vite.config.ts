import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The application is served from the root of an Isolated Web App, so the base
// path is "/".
//
// Chrome gives every Isolated Web App this Content Security Policy:
//
//   script-src 'self' 'wasm-unsafe-eval'; require-trusted-types-for 'script';
//   style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss: blob: data:
//
// For an Isolated Web App, 'self' means a file inside the bundle. It does not
// include inline scripts. Two settings below follow from that rule:
//
//  1. modulePreload.polyfill is off. The polyfill is an inline script.
//  2. The build makes one JavaScript chunk that index.html loads with a src
//     attribute. The application must not be packed into one HTML file.
export default defineConfig({
  base: '/',
  build: {
    // The build writes to the dist directory of the repository root, because
    // the bundle script and the development server both read from there.
    outDir: '../dist',
    emptyOutDir: true,
    target: 'esnext',
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // One chunk. A dynamic import would add a loader that fetches a second
        // file, and fewer files make the bundle easier to check.
        codeSplitting: false,
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
