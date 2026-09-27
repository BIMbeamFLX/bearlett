// A new wallet or a restored one. The seed phrase is the whole backup for
// every note held on the wallet's own keys (LUD-25 Seed & derivation); the
// passphrase only protects it on this device.
import {createSignal, For, Match, Show, Switch} from 'solid-js'
import {Action, Busy, Field} from '../kit.tsx'
import {run} from '../session.ts'
import {isMnemonic, newMnemonic, normalizeMnemonic} from '../../wallet/vault.ts'
import {Wallet, type Ports} from '../../wallet/wallet.ts'

type Step = 'choose' | 'words' | 'restore' | 'passphrase'

export const Setup = (props: {
  ports: Ports
  onReady: (wallet: Wallet, restored: boolean) => void
}) => {
  const [step, setStep] = createSignal<Step>('choose')
  const [words, setWords] = createSignal('')
  const [restored, setRestored] = createSignal(false)
  const [passphrase, setPassphrase] = createSignal('')
  const [repeat, setRepeat] = createSignal('')

  const create = () =>
    run('Sealing your wallet', async () => {
      const wallet = await Wallet.create(props.ports, words(), passphrase())
      props.onReady(wallet, restored())
    })

  return (
    <main>
      <Switch>
        <Match when={step() === 'choose'}>
          <section class="panel">
            <h1>Bearlett</h1>
            <p>
              A wallet for LNURLcash notes (LUD-25): bearer notes and notes on
              your own keys, minted and redeemed over plain LNURL.
            </p>
            <div class="actions">
              <Action
                onClick={() => {
                  setWords(newMnemonic())
                  setStep('words')
                }}
              >
                New wallet
              </Action>
              <Action kind="secondary" onClick={() => setStep('restore')}>
                Restore from words
              </Action>
            </div>
          </section>
        </Match>
        <Match when={step() === 'words'}>
          <section class="panel">
            <h2>Your 12 words</h2>
            <p>
              Write them down, in order. They restore every note held on your
              own keys. Anyone who has them can spend those notes.
            </p>
            <ol class="words">
              <For each={words().split(' ')}>{word => <li>{word}</li>}</For>
            </ol>
            <Action onClick={() => setStep('passphrase')}>
              I wrote them down
            </Action>
          </section>
        </Match>
        <Match when={step() === 'restore'}>
          <section class="panel">
            <h2>Restore</h2>
            <Field label="Your 12 or 24 words">
              <textarea
                value={words()}
                onInput={e => setWords(e.currentTarget.value)}
                autocomplete="off"
                spellcheck={false}
              />
            </Field>
            <Show when={words().trim() && !isMnemonic(words())}>
              <p class="warn">These words are not a valid seed phrase.</p>
            </Show>
            <Action
              disabled={!isMnemonic(words())}
              onClick={() => {
                setWords(normalizeMnemonic(words()))
                setRestored(true)
                setStep('passphrase')
              }}
            >
              Continue
            </Action>
          </section>
        </Match>
        <Match when={step() === 'passphrase'}>
          <section class="panel">
            <h2>Passphrase</h2>
            <p class="quiet">
              Locks the words on this device. It is not part of the backup: the
              words alone restore the wallet anywhere.
            </p>
            <Field label="Passphrase">
              <input
                type="password"
                value={passphrase()}
                onInput={e => setPassphrase(e.currentTarget.value)}
                autocomplete="new-password"
              />
            </Field>
            <Field label="Repeat">
              <input
                type="password"
                value={repeat()}
                onInput={e => setRepeat(e.currentTarget.value)}
                autocomplete="new-password"
              />
            </Field>
            <Show when={!passphrase()}>
              <p class="warn">
                Without a passphrase, anyone using this device can open the
                wallet.
              </p>
            </Show>
            <Action disabled={passphrase() !== repeat()} onClick={create}>
              {restored() ? 'Restore wallet' : 'Create wallet'}
            </Action>
            <Busy />
          </section>
        </Match>
      </Switch>
    </main>
  )
}

export const Unlock = (props: {
  ports: Ports
  onReady: (wallet: Wallet) => void
  onReset: () => void
}) => {
  const [passphrase, setPassphrase] = createSignal('')
  const unlock = () =>
    run('Unlocking', async () =>
      props.onReady(await Wallet.unlock(props.ports, passphrase()))
    )
  return (
    <main>
      <section class="panel">
        <h1>Unlock</h1>
        <form
          onSubmit={e => {
            e.preventDefault()
            unlock()
          }}
        >
          <Field label="Passphrase">
            <input
              type="password"
              value={passphrase()}
              onInput={e => setPassphrase(e.currentTarget.value)}
              autocomplete="current-password"
              autofocus
            />
          </Field>
          <div class="row">
            <Action onClick={unlock}>Unlock</Action>
            <button type="button" class="link" onClick={() => props.onReset()}>
              Use other words
            </button>
          </div>
        </form>
        <Busy />
      </section>
    </main>
  )
}
