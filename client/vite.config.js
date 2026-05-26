import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// `base` controls how asset URLs are written into the built
// index.html. The webserver-hosted production install needs absolute
// paths from the site root ("/assets/..."), but the Electron-bundled
// build loads index.html from a file:// URL where "/assets/..." would
// resolve to the filesystem root rather than the bundle's own
// directory. The electron build script sets ELECTRON_BUILD=true so
// we know to emit relative paths instead.
const isElectronBuild = process.env.ELECTRON_BUILD === 'true';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: isElectronBuild ? './' : '/',
  resolve: {
    alias: {
      // Fix Carbon's ~@ibm/plex webpack-style imports for Vite
      '~@ibm/plex': path.resolve(__dirname, 'node_modules/@ibm/plex')
    }
  },
  server: {
    host: '0.0.0.0',  // Listen on all interfaces for Tailscale access
    port: 5173,
    proxy: {
      '/docs': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
