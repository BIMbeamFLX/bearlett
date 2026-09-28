// One app for both homes: the web app and the docked Hangar napplet. Only
// the platform's ports differ.
import {createSignal, Match, onCleanup, onMount, Show, Switch} from 'solid-js'
import {Setup, Unlock} from './screens/Setup.tsx'
import {Home} from './screens/Home.tsx'
import {Receive} from './screens/Receive.tsx'
import {Send} from './screens/Send.tsx'
import {Cards} from './screens/Cards.tsx'
import {Settings} from './screens/Settings.tsx'
import {formatSats} from './format.ts'
import {toast, watchWallet} from './session.ts'
import {holdWalletLock, type Platform} from '../platform/platform.ts'
import {Wallet} from '../wallet/wallet.ts'

type Phase = 'boot' | 'elsewhere' | 'broken' | 'setup' | 'unlock' | 'ready'
type Tab = 'wallet' | 'receive' | 'send' | 'cards' | 'settings'

const SETTLE_EVERY_MS = 15_000
const ADDRESS_EVERY_MS = 60_000

export const App = (props: {platform: Platform}) => {
  const ports = {net: props.platform.net, store: props.platform.store}
  const [phase, setPhase] = createSignal<Phase>('boot')
  const [wallet, setWallet] = createSignal<(() => Wallet) | null>(null)
  const [tab, setTab] = createSignal<Tab>('wallet')
  const [problem, setProblem] = createSignal('')
  const timers: ReturnType<typeof setInterval>[] = []
  onCleanup(() => timers.forEach(clearInterval))

  onMount(async () => {
    if (props.platform.kind === 'web' && !(await holdWalletLock())) {
      setPhase('elsewhere')
      return
    }
    try {
      setPhase((await Wallet.exists(props.platform.store)) ? 'unlock' : 'setup')
    } catch (err) {
      // a shell that does not answer storage requests: say so, do not crash
      setProblem(
        `Bearlett cannot read its storage here: ${(err as Error).message}`
      )
      setPhase('broken')
    }
  })

  const ready = (opened: Wallet, restored = false) => {
    setWallet(() => watchWallet(opened))
    setPhase('ready')
    if (restored) setTab('settings')
    // settle what is underway, quietly: failures are retried next round
    const quiet = (task: () => Promise<unknown>) => () => {
      if (document.visibilityState === 'visible') task().catch(() => {})
    }
    quiet(() => opened.settle())()
    timers.push(
      setInterval(
        quiet(() => opened.settle()),
        SETTLE_EVERY_MS
      )
    )
    timers.push(
      setInterval(
        quiet(async () => {
          for (const domain of Object.keys(opened.snapshot.addresses))
            await opened.checkAddress(domain)
        }),
        ADDRESS_EVERY_MS
      )
    )
  }

  // locking drops every key from memory
  const lock = () => location.reload()

  const nav = (id: Tab, label: string) => (
    <button
      aria-current={tab() === id ? 'page' : undefined}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  )

  return (
    <>
      <header class="top">
        <span class="brand">Bearlett</span>
        <Show when={wallet()}>
          {w => <span class="balance">{formatSats(w()().balanceMsat())}</span>}
        </Show>
      </header>
      <Switch>
        <Match when={phase() === 'boot'}>
          <main />
        </Match>
        <Match when={phase() === 'broken'}>
          <main>
            <section class="panel">
              <p class="warn">{problem()}</p>
            </section>
          </main>
        </Match>
        <Match when={phase() === 'elsewhere'}>
          <main>
            <section class="panel">
              <p>
                Bearlett is already open in another tab. Close it there to use
                it here.
              </p>
            </section>
          </main>
        </Match>
        <Match when={phase() === 'setup'}>
          <Setup ports={ports} onReady={ready} />
        </Match>
        <Match when={phase() === 'unlock'}>
          <Unlock
            ports={ports}
            onReady={opened => ready(opened)}
            onReset={() => setPhase('setup')}
          />
        </Match>
        <Match when={phase() === 'ready' && wallet()}>
          {w => (
            <>
              <nav class="tabs">
                {nav('wallet', 'Wallet')}
                {nav('receive', 'Receive')}
                {nav('send', 'Send')}
                {nav('cards', 'Cards')}
                {nav('settings', 'Settings')}
              </nav>
              <main>
                <Switch>
                  <Match when={tab() === 'wallet'}>
                    <Home wallet={w()} />
                  </Match>
                  <Match when={tab() === 'receive'}>
                    <Receive wallet={w()} platform={props.platform} />
                  </Match>
                  <Match when={tab() === 'send'}>
                    <Send wallet={w()} platform={props.platform} />
                  </Match>
                  <Match when={tab() === 'cards'}>
                    <Cards wallet={w()} />
                  </Match>
                  <Match when={tab() === 'settings'}>
                    <Settings
                      wallet={w()}
                      platform={props.platform}
                      onLock={lock}
                    />
                  </Match>
                </Switch>
              </main>
            </>
          )}
        </Match>
      </Switch>
      <Show when={toast()}>
        {t => (
          <div class={`toast${t().error ? ' error' : ''}`} role="status">
            {t().text}
          </div>
        )}
      </Show>
    </>
  )
}
