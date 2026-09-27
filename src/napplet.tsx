// The Hangar napplet: the shell's resource and storage domains, and its
// theme painted onto the Hypershell chrome.
import {render} from 'solid-js/web'
import {App} from './ui/App.tsx'
import {nappletPlatform} from './platform/platform.ts'
import {startTheme} from './ui/theme.ts'
import './ui/style.css'

startTheme()
render(
  () => <App platform={nappletPlatform()} />,
  document.getElementById('root')!
)
