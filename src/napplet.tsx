// The Hangar napplet: the shell's resource and storage domains, and its
// theme painted onto the Hypershell chrome. Without the domains it needs,
// it says so instead of failing to boot.
import {render} from 'solid-js/web'
import {App} from './ui/App.tsx'
import {nappletPlatform} from './platform/napplet.ts'
import type {Platform} from './platform/platform.ts'
import {startTheme} from './ui/theme.ts'
import './ui/style.css'

startTheme()
let platform: Platform | null = null
let problem = ''
try {
  platform = nappletPlatform()
} catch (err) {
  problem = (err as Error).message
}
render(
  () =>
    platform ? (
      <App platform={platform} />
    ) : (
      <main>
        <section class="panel">
          <h1>Bearlett</h1>
          <p>{problem}</p>
        </section>
      </main>
    ),
  document.getElementById('root')!
)
