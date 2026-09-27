import type {Plugin} from 'vite'
import {defineConfig} from 'vite'
import solidPlugin from 'vite-plugin-solid'

// Content-Security-Policy as a <meta> in production builds: a static host
// cannot set headers. The app ships no inline scripts and no third-party
// code. connect-src stays open to any https origin, since LNURL calls go to
// whatever mint a note names; plain http only for local and onion mints,
// the same rule src/lnurl/net.ts applies. Dev is left out: the HMR
// websocket would need exceptions that do not belong in the shipped policy.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; connect-src https: http://localhost:* http://127.0.0.1:* http://*.onion http://*.onion:*; object-src 'none'; base-uri 'none'; form-action 'none'"

const cspMeta = (): Plugin => ({
  name: 'csp-meta',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {'http-equiv': 'Content-Security-Policy', content: CSP},
      injectTo: 'head-prepend'
    }
  ]
})

export default defineConfig({
  plugins: [cspMeta(), solidPlugin()],
  // relative paths: the same build works at a domain root or a subpath
  base: './',
  server: {port: 3000},
  build: {target: 'esnext'}
})
