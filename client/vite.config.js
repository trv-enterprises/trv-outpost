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
    // Proxy the API (and friends) to the Go server so the dev app is
    // SAME-ORIGIN with /api — required for the httpOnly refresh cookie
    // (SameSite=Lax, credentials:'same-origin') to be stored on
    // /api/auth/session and sent on /api/auth/refresh. The client uses a
    // relative API base in dev (see getApiBaseUrl) so these paths land
    // here. ws:true covers the streaming SSE/WebSocket endpoints
    // (/api/.../ws, ?st=...). Mirrors the homelab Caddyfile's /api proxy.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true
      },
      '/health': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/mcp': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true
      },
      '/swagger': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/docs': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
