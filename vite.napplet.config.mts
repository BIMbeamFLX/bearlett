import {defineConfig} from 'vite'
import type {Plugin} from 'vite'
import solid from 'vite-plugin-solid'
import {nip5aManifest} from '@napplet/vite-plugin'
import {readFileSync} from 'node:fs'

type NappletOptions = Parameters<typeof nip5aManifest>[0] & {
  requires: string[]
}

/* The manifest and the page declare the same napplet. A shell that loads the
   page on its own reads `napplet-type` (the manifest's d-tag) and
   `napplet-requires` (every domain the code asks the shell for) from meta
   tags; the plugin writes neither into the HTML, so both are added here from
   the very options the manifest is built from. The hook runs `pre`, so the
   metas land in the first 1024 bytes, before the inlined bundle, where the
   HTML prescan and a shell that reads only the start of the page look.
   `npm run check:napplets` fails when page and manifest differ. */
const declaredNapplet = (options: NappletOptions): Plugin[] => [
  nip5aManifest(options),
  {
    name: 'napplet-meta',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [
        {
          tag: 'meta',
          attrs: {name: 'napplet-type', content: options.nappletType},
          injectTo: 'head'
        },
        {
          tag: 'meta',
          attrs: {
            name: 'napplet-requires',
            content: [...options.requires].sort().join(',')
          },
          injectTo: 'head'
        }
      ]
    }
  }
]

export default defineConfig({
  mode: 'napplet',
  publicDir: false,
  plugins: [
    solid(),
    /* the napplet page stands in for index.html, before Vite adds scripts */
    {
      name: 'napplet-page',
      transformIndexHtml: {
        order: 'pre' as const,
        handler: () => readFileSync('napplet/index.html', 'utf8')
      }
    },
    declaredNapplet({
      nappletType: 'bearlett-wallet',
      title: 'Bearlett',
      description:
        'An LNURLcash (LUD-25) wallet: notes on your own keys, bearer notes, Lightning in and out.',
      artifactMode: 'single-file',
      /* Every NAP domain the code asks the shell for. `resource`: every mint
         call goes through the shell (GET only). `storage`: the sealed seed
         and bookkeeping. `theme`: the shell paints its skin onto the
         Hypershell chrome (src/ui/theme.ts); without it the defaults stay. */
      requires: ['storage', 'resource', 'theme'],
      archetypes: []
    })
  ],
  build: {
    outDir: 'dist-napplet',
    emptyOutDir: true,
    target: 'esnext',
    assetsInlineLimit: 1_000_000
  }
})
