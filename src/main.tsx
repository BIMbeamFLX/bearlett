// The web app: fetch for the network, localStorage for the sealed records.
import {render} from 'solid-js/web'
import {App} from './ui/App.tsx'
import {webPlatform} from './platform/web.ts'
import './ui/style.css'

render(() => <App platform={webPlatform()} />, document.getElementById('root')!)
