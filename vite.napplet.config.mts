import {defineConfig} from 'vite'
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
    const collection = resolveEdition(edition, process.env.BEARLETT_MINT)
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
        nip5aManifest({
          nappletType: `bearlett-collection-${edition}`,
          title,
          description: `Hold, inspect and hand over the ${title} cards you own.`,
          artifactMode: 'single-file',
          /* No `storage`-free variant: a collection that cannot persist its
             key is not a collection, it is a fresh wallet on every open. */
          requires: ['storage', 'resource', 'inc'],
          archetypes: [
            {slug: 'collection', convention: 'napplet:collection/open'},
            {slug: 'collection', convention: 'napplet:collection/inventory'}
          ]
        })
      ],
      build: {
        outDir: `dist-collection-${edition}`,
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
      nip5aManifest({
        nappletType: designer ? 'bearlett-notes' : 'bearlett-wallet',
        title: designer ? 'Bearlett Notes' : 'Bearlett Wallet',
        description: designer
          ? 'Design bearer notes with your own images, colors and words.'
          : 'A bearer wallet for LNURLcash and Cashu sats, connected through Lightning.',
        artifactMode: 'single-file',
        requires: designer
          ? ['storage', 'inc']
          : ['storage', 'resource', 'inc'],
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
