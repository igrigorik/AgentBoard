import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json' with { type: 'json' };
import pkg from './package.json' with { type: 'json' };
import path from 'path';
import { webmcpCompilerPlugin } from './scripts/vite-plugin-webmcp-compiler';

// Single source of truth: inject version from package.json into manifest
const manifestWithVersion = {
  ...manifest,
  version: pkg.version,
};

export default defineConfig({
  plugins: [
    webmcpCompilerPlugin(), // Compile WebMCP tools first
    crx({ manifest: manifestWithVersion }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@lib': path.resolve(__dirname, './src/lib'),
      '@types': path.resolve(__dirname, './src/types'),
      // Use CSP-safe Ajv shim - real Ajv uses new Function() which violates extension CSP
      // Also fixes ESM import issue (ajv doesn't have default export in ESM)
      ajv: path.resolve(__dirname, 'src/lib/ajv-csp-safe.js'),
    },
  },
  build: {
    // Chrome extensions need to output multiple entry points
    rollupOptions: {
      input: {
        // These will be auto-detected from manifest.json by crx plugin
        // but we can add manual chunks if needed
        // Manually include sidebar since we removed it from manifest
        sidebar: path.resolve(__dirname, 'src/sidebar/index.html'),
        // WebMCP content scripts
        'content-scripts/webmcp-polyfill': path.resolve(
          __dirname,
          'src/content-scripts/webmcp-polyfill.js'
        ),
        'content-scripts/page-bridge': path.resolve(
          __dirname,
          'src/content-scripts/page-bridge.js'
        ),
        'content-scripts/relay': path.resolve(__dirname, 'src/content-scripts/relay.js'),
      },
      output: {
        // Ensure consistent chunk naming
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: '[name].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
    // Chrome extensions have stricter CSP, can't use inline scripts
    // Only minify for release builds (use RELEASE=1 npm run build for production)
    minify: process.env.RELEASE ? 'terser' : false,
    terserOptions: process.env.RELEASE
      ? {
          format: {
            // Remove all comments in production
            comments: false,
          },
        }
      : undefined,
    // Generate source maps for dev, exclude for release (smaller package, protects source)
    sourcemap: !process.env.RELEASE,
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
  // Chrome extension specific optimizations
  optimizeDeps: {
    // With our CSP-safe ajv shim, we can pre-bundle normally
  },
});
