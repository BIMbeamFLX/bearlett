import {defineConfig} from 'vite'
import type {Plugin} from 'vite'
import solid from 'vite-plugin-solid'
import {nip5aManifest} from '@napplet/vite-plugin'
import {readFileSync} from 'node:fs'
import {
  EDITIONS,
  editionById,
  isEditionMode,
  resolveEdition
} from './src/napplet/collection/editions.ts'

/* Vite's own default modes, which mean "build the wallet napplet". */
const WALLET_MODES = new Set(['production', 'development', 'napplet'])

type NappletOptions = Parameters<typeof nip5aManifest>[0] & {
  requires: string[]
}

/* The manifest and the page declare the same napplet. A shell that loads the
   page on its own reads `napplet-type` (the manifest's d-tag) and
   `napplet-requires` (the NAP domains the code uses from the shell) from
   meta tags; the plugin writes neither into the HTML, so both are put in here
   from the very options the manifest is built from, and cannot drift from it. */
const declaredNapplet = (options: NappletOptions): Plugin[] => [
  nip5aManifest(options),
  {
    name: 'napplet-meta',
    transformIndexHtml: () => [
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
]

export default defineConfig(({mode}) => {
  /* A collection builds once per edition, and the mode names which one.
     Anything that is neither a known edition nor one of the other apps is a
     typo, and it stops the build. Falling through to the wallet would put a
     napplet nobody asked for into a directory nobody checks. */
  const edition = isEditionMode(mode) ? mode : null
  const designer = mode === 'notes'
  if (!edition && !designer && !WALLET_MODES.has(mode))
    throw new Error(
      `Unknown build mode "${mode}". Use notes, one of the collections ` +
        `(${Object.keys(EDITIONS).sort().join(', ')}), or no mode for the wallet.`
    )

  if (edition) {
    const collection = resolveEdition(
      edition,
      process.env.BEARLETT_MINT,
      process.env.BEARLETT_ACCOUNT_WALLETS
    )
    const title = editionById(edition)!.title
    return {
      mode,
      publicDir: false,
      define: {
        __COLLECTION__: JSON.stringify(collection)
      },
      plugins: [
        solid(),
        {
          name: 'collection-napplet-entry',
          transformIndexHtml: {
            order: 'pre' as const,
            handler: () => readFileSync('napplet/collection.html', 'utf8')
          }
        },
        declaredNapplet({
          nappletType: `bearlett-collection-${edition}`,
          title,
          description: `Hold, inspect and hand over the ${title} cards you own.`,
          artifactMode: 'single-file',
          /* No `storage`-free variant: a collection that cannot persist its
             key is not a collection, it is a fresh wallet on every open.
             The mint capability, `nutft`, is required too but cannot be
             declared here: the plugin keeps only registered NAP domains and
             drops any other name without a word, as it does for the sats
             wallet's `cashu`. docs/NAPPLETS.md says so for a shell author. */
          requires: ['storage', 'resource', 'inc'],
          /* Receiving is by paste only. The collection still stages a card
             another napplet hands over on napplet:collection/receive for the
             holder to confirm, but no build asks a host to route one there
             until that route is agreed with the host. */
          archetypes: [
            {slug: 'collection', convention: 'napplet:collection/open'},
            {slug: 'collection', convention: 'napplet:collection/inventory'}
          ]
        })
      ],
      build: {
        /* A build with account wallets lands beside the alpha build, never
           over it, so the two artifacts cannot be mistaken for each other. */
        outDir: `dist-collection-${edition}${collection.accountWallets ? '-accounts' : ''}`,
        target: 'esnext',
        assetsInlineLimit: 1000000
      }
    }
  }

  return {
    mode: designer ? 'notes' : 'napplet',
    publicDir: false,
    plugins: [
      solid(),
      {
        name: 'wallet-napplet-entry',
        transformIndexHtml: {
          order: 'pre' as const,
          handler: () =>
            readFileSync(
              designer ? 'napplet/notes.html' : 'napplet/index.html',
              'utf8'
            )
        }
      },
      declaredNapplet({
        nappletType: designer ? 'bearlett-notes' : 'bearlett-wallet',
        title: designer ? 'Bearlett Notes' : 'Bearlett Wallet',
        description: designer
          ? 'Design bearer notes with your own images, colors and words.'
          : 'A bearer wallet for LNURLcash and Cashu sats, connected through Lightning.',
        artifactMode: 'single-file',
        /* `theme`: NAP-THEME, so the shell paints its skin onto the Hypershell
           chrome (src/napplet/theme.ts); a shell without it leaves the defaults.
           `intent`: Notes pushes a design to a wallet with intent.open
           (src/napplet/note-interface.ts). The wallet's fs, link, ble and
           serial buttons only appear where the shell has them, so they are
           not required. */
        requires: designer
          ? ['storage', 'inc', 'intent', 'theme']
          : ['storage', 'resource', 'inc', 'theme'],
        archetypes: designer
          ? [
              {
                slug: 'bearer-designer',
                convention: 'napplet:bearer-designer/open'
              }
            ]
          : ['open', 'receive', 'pay', 'design'].map(action => ({
              slug: 'wallet',
              convention: `napplet:wallet/${action}`
            }))
      })
    ],
    build: {
      outDir: designer ? 'dist-notes' : 'dist-napplet',
      target: 'esnext',
      assetsInlineLimit: 1000000
    }
  }
})
