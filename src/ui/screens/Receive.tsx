// Three ways in: a note someone hands over, a Lightning payment that mints
// a note on this wallet's own key, and a Lightning Address that mints on
// its own for every payment.
import {createSignal, Match, onCleanup, Show, Switch} from 'solid-js'
import {Action, Busy, Copy, Field, MintSelect, Qr, Scanner} from '../kit.tsx'
import {formatSats, parseSats} from '../format.ts'
import {notify, run} from '../session.ts'
import {classifyInput, type NoteLink} from '../../lnurl/links.ts'
import {UnknownMintError, type Wallet} from '../../wallet/wallet.ts'
import type {Operation} from '../../wallet/state.ts'
import type {Platform} from '../../platform/platform.ts'

type Tab = 'note' | 'lightning' | 'address'
type MintOp = Extract<Operation, {kind: 'mint'}>

export const Receive = (props: {
  wallet: () => Wallet
  platform: Platform
  start?: string
}) => {
  const w = () => props.wallet()
  const mints = () => Object.values(w().snapshot.mints)
  const [tab, setTab] = createSignal<Tab>('note')
  const [domain, setDomain] = createSignal(mints()[0]?.domain ?? '')

  // ---- a note ----
  const [text, setText] = createSignal(props.start ?? '')
  const [scanning, setScanning] = createSignal(false)
  const [stranger, setStranger] = createSignal<{
    domain: string
    link: NoteLink
  } | null>(null)

  const receiveNote = (value = text()) =>
    run('Checking the note with its mint', async () => {
      const input = classifyInput(value)
      if (input?.kind !== 'note') throw new Error('That is not a note link.')
      try {
        const note = await w().receive(input.link)
        notify(
          note.role === 'incoming'
            ? `Kept ${formatSats(note.amountMsat)} to rotate once the mint answers.`
            : `Received ${formatSats(note.amountMsat)}.`
        )
        setText('')
      } catch (err) {
        if (!(err instanceof UnknownMintError)) throw err
        setStranger({domain: err.domain, link: input.link})
      }
    })

  const trustAndReceive = (link: NoteLink) =>
    run('Adding the mint', async () => {
      await w().trustMintOf(link.endpoint)
      setStranger(null)
    }).then(() => receiveNote(text()))

  // ---- a Lightning payment ----
  const [amount, setAmount] = createSignal('')
  const [invoice, setInvoice] = createSignal<MintOp | null>(null)
  let poll: ReturnType<typeof setInterval> | undefined
  onCleanup(() => clearInterval(poll))

  const requestMint = () =>
    run('Asking the mint for an invoice', async () => {
      const msat = parseSats(amount())
      if (!msat) throw new Error('Enter an amount in sats.')
      const op = await w().requestMint(domain(), msat)
      setInvoice(op)
      clearInterval(poll)
      poll = setInterval(async () => {
        try {
          if (await w().settleMint(op)) {
            clearInterval(poll)
            setInvoice(null)
            notify(`Minted ${formatSats(op.amountMsat)} (less any mint fee).`)
          }
        } catch {
          // checked again on the next tick
        }
      }, 3000)
    })

  // ---- a Lightning Address ----
  const [username, setUsername] = createSignal('')
  const address = () => w().snapshot.addresses[domain()]
  const addressText = () => {
    const a = address()
    return a
      ? `${a.username}@${new URL(w().mint(domain()).withdrawLink).host}`
      : ''
  }

  return (
    <>
      <nav class="tabs">
        <button
          aria-current={tab() === 'note' ? 'page' : undefined}
          onClick={() => setTab('note')}
        >
          Note
        </button>
        <button
          aria-current={tab() === 'lightning' ? 'page' : undefined}
          onClick={() => setTab('lightning')}
        >
          Lightning
        </button>
        <button
          aria-current={tab() === 'address' ? 'page' : undefined}
          onClick={() => setTab('address')}
        >
          Address
        </button>
      </nav>
      <section class="panel">
        <Switch>
          <Match when={tab() === 'note'}>
            <h2>Receive a note</h2>
            <Show when={scanning()}>
              <Scanner
                onScan={value => {
                  setScanning(false)
                  setText(value)
                  receiveNote(value)
                }}
                onClose={() => setScanning(false)}
              />
            </Show>
            <Field
              label="Note link"
              hint="An lnurlw:// link, an LNURL, or a withdraw URL with k1."
            >
              <textarea
                value={text()}
                onInput={e => setText(e.currentTarget.value)}
                spellcheck={false}
              />
            </Field>
            <Show when={stranger()}>
              {s => (
                <p class="warn">
                  This note is from {s().domain}, which is not one of your
                  mints. Only take notes from mints you trust to pay them out.{' '}
                  <button
                    class="link"
                    onClick={() => trustAndReceive(s().link)}
                  >
                    Trust {s().domain} and receive
                  </button>
                </p>
              )}
            </Show>
            <div class="row">
              <Action disabled={!text().trim()} onClick={() => receiveNote()}>
                Receive
              </Action>
              <Show when={props.platform.canScan && !scanning()}>
                <Action kind="secondary" onClick={() => setScanning(true)}>
                  Scan
                </Action>
              </Show>
            </div>
          </Match>
          <Match when={tab() === 'lightning'}>
            <h2>Mint over Lightning</h2>
            <Show
              when={mints().length}
              fallback={<p class="quiet">Add a mint under Settings first.</p>}
            >
              <Show
                when={invoice()}
                fallback={
                  <>
                    <MintSelect
                      mints={mints()}
                      value={domain()}
                      onChange={setDomain}
                      balanceOf={d => w().balanceMsat(d)}
                    />
                    <Field label="Amount (sat)">
                      <input
                        inputmode="numeric"
                        value={amount()}
                        onInput={e => setAmount(e.currentTarget.value)}
                      />
                    </Field>
                    <Show when={w().snapshot.mints[domain()]?.fee}>
                      {fee => (
                        <p class="quiet">
                          This mint keeps {fee().baseMsat / 1000} sat plus{' '}
                          {fee().ppm / 10_000}% of every mint.
                        </p>
                      )}
                    </Show>
                    <Action onClick={requestMint}>Get invoice</Action>
                  </>
                }
              >
                {op => (
                  <>
                    <p>
                      Pay this invoice from any Lightning wallet. The note is
                      yours once it settles.
                    </p>
                    <Qr value={op().pr.toUpperCase()} />
                    <div class="row">
                      <Copy value={op().pr} label="Copy invoice" />
                    </div>
                    <p class="quiet">
                      Waiting for the payment… You can leave this screen; it
                      stays under Wallet.
                    </p>
                  </>
                )}
              </Show>
            </Show>
          </Match>
          <Match when={tab() === 'address'}>
            <h2>Lightning Address</h2>
            <Show
              when={mints().length}
              fallback={<p class="quiet">Add a mint under Settings first.</p>}
            >
              <MintSelect
                mints={mints()}
                value={domain()}
                onChange={setDomain}
                balanceOf={d => w().balanceMsat(d)}
              />
              <Show
                when={address()}
                fallback={
                  <Show
                    when={props.platform.kind === 'web'}
                    fallback={
                      <p class="quiet">
                        Registering needs the Bearlett web app: the Hangar only
                        lets napplets read from mints.
                      </p>
                    }
                  >
                    <p class="quiet">
                      The mint mints a note on your own keys for every payment
                      to this address. It learns your watch-only key for this
                      mint (cx1), so it can tell which of your notes there are
                      yours.
                    </p>
                    <Field label="Name">
                      <input
                        value={username()}
                        onInput={e => setUsername(e.currentTarget.value)}
                        autocomplete="off"
                      />
                    </Field>
                    <Action
                      disabled={!username().trim()}
                      onClick={() =>
                        run('Registering', () =>
                          w().registerAddress(domain(), username())
                        )
                      }
                    >
                      Register
                    </Action>
                  </Show>
                }
              >
                <p class="amount">{addressText()}</p>
                <Qr value={addressText()} />
                <div class="row">
                  <Copy value={addressText()} />
                  <Action
                    kind="secondary"
                    onClick={() =>
                      run('Looking for payments', async () => {
                        const found = await w().checkAddress(domain())
                        notify(
                          found
                            ? `Found ${found} new payments.`
                            : 'Nothing new.'
                        )
                      })
                    }
                  >
                    Check for payments
                  </Action>
                </div>
              </Show>
            </Show>
          </Match>
        </Switch>
        <Busy />
      </section>
    </>
  )
}
