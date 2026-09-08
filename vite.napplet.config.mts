import {defineConfig} from 'vite'
import solid from 'vite-plugin-solid'
import {nip5aManifest} from '@napplet/vite-plugin'
import {readFileSync} from 'node:fs'

export default defineConfig(({mode}) => {
  const designer = mode === 'designer'
  return {
    mode: designer ? 'designer' : 'napplet',
    publicDir: false,
    plugins: [
      solid(),
      {
        name: 'wallet-napplet-entry',
        transformIndexHtml: {
          order: 'pre',
          handler: () =>
            readFileSync('napplet/index.html', 'utf8').replace(
              'main.tsx',
              designer ? 'designer.tsx' : 'main.tsx'
            )
        }
      },
      nip5aManifest({
        nappletType: designer
          ? 'lnurlcash-bearer-designer'
          : 'lnurlcash-wallet',
        title: designer ? 'Paper Studio — LNURLcash' : 'LNURLcash Wallet',
        description: designer
          ? 'Design bearer notes with your own images, colors and words.'
          : 'Receive, mint, split, combine and spend LNURLcash notes.',
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
          : ['open', 'receive', 'pay'].map(action => ({
              slug: 'wallet',
              convention: `napplet:wallet/${action}`
            }))
      })
    ],
    build: {
      outDir: designer ? 'dist-designer' : 'dist-napplet',
      target: 'esnext',
      assetsInlineLimit: 1000000
    }
  }
})
