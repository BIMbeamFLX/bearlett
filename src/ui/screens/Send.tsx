// Three ways out: a note link anyone can redeem, paying an invoice or a
// Lightning Address (as an internal transfer when the payee is at one of
// your mints), and minting straight onto someone's note key.
import {createMemo, createSignal, Match, Show, Switch} from 'solid-js'
import {
  Action,
  Busy,
  Copy,
  Field,
  MintSelect,
  NoteCard,
  Scanner
} from '../kit.tsx'
import {formatSats, parseSats} from '../format.ts'
import {notify, run} from '../session.ts'
import {classifyInput, invoiceAmountMsat} from '../../lnurl/links.ts'
import type {PayRequest} from '../../lnurl/pay.ts'
import type {Wallet} from '../../wallet/wallet.ts'
import type {Platform} from '../../platform/platform.ts'

type Tab = 'note' | 'pay' | 'key' | 'lock'

export const Send = (props: {wallet: () => Wallet; platform: Platform}) => {
  const w = () => props.wallet()
  const mints = () => Object.values(w().snapshot.mints)
  const richest = () =>
    [...mints()].sort(
      (a, b) => w().balanceMsat(b.domain) - w().balanceMsat(a.domain)
    )[0]?.domain ?? ''
  const [tab, setTab] = createSignal<Tab>('note')
  const [domain, setDomain] = createSignal(richest())
  const [amount, setAmount] = createSignal('')

  // ---- a note link ----
  const [memo, setMemo] = createSignal('')
  const [link, setLink] = createSignal<string | null>(null)
  const makeNote = () =>
    run('Making the note', async () => {
      const msat = parseSats(amount())
      if (!msat) throw new Error('Enter an amount in sats.')
      const note = await w().send(domain(), msat, memo() || undefined)
      setLink(w().noteLink(note.q))
    })

  // ---- paying ----
  const [key, setKey] = createSignal('')
  const [target, setTarget] = createSignal('')
  const [scanning, setScanning] = createSignal(false)
  const [pay, setPay] = createSignal<PayRequest | null>(null)
  const input = createMemo(() => classifyInput(target()))
  const invoiceMsat = () => {
    const i = input()
    return i?.kind === 'invoice' ? invoiceAmountMsat(i.invoice) : null
  }

  const lookUp = () =>
    run('Looking up the payee', async () => {
      const i = input()
      if (i?.kind === 'cp1') {
        setKey(i.cp1)
        setTab('key')
        return
      }
      if (i?.kind !== 'lnurl')
        throw new Error('Paste an invoice, a Lightning Address or an LNURL.')
      const request = await w().payRequest(i.url)
      setPay(request)
      const transferAt = w().transferMint(request)
      if (transferAt) setDomain(transferAt)
    })

  const payNow = () =>
    run('Paying', async () => {
      const i = input()
      if (i?.kind === 'invoice') {
        await w().pay(domain(), i.invoice)
        notify('Payment sent to the mint. It confirms under Wallet.')
      } else {
        const request = pay()
        const msat = parseSats(amount())
        if (!request || !msat) throw new Error('Enter an amount in sats.')
        if (w().transferMint(request) === domain()) {
          await w().transfer(request, msat)
          notify(`Sent ${formatSats(msat)} inside the mint.`)
        } else {
          await w().pay(domain(), await w().invoiceFor(request, msat))
          notify('Payment sent to the mint. It confirms under Wallet.')
        }
      }
      setTarget('')
      setPay(null)
      setAmount('')
    })

  // ---- a note key ----
  const sendToKey = () =>
    run('Sending', async () => {
      const i = classifyInput(key())
      const msat = parseSats(amount())
      if (i?.kind !== 'cp1') throw new Error('Paste a cp1 note key.')
      if (!msat) throw new Error('Enter an amount in sats.')
      await w().sendToKey(domain(), msat, i.q)
      notify(`Sent ${formatSats(msat)} to that key.`)
      setKey('')
    })

  // ---- a timelock ----
  const [until, setUntil] = createSignal('')
  const lockNow = () =>
    run('Locking', async () => {
      const msat = parseSats(amount())
      const at = Date.parse(until())
      if (!msat) throw new Error('Enter an amount in sats.')
      if (!Number.isFinite(at)) throw new Error('Pick the time it unlocks.')
      await w().lock(domain(), msat, Math.floor(at / 1000))
      notify(
        `Locked ${formatSats(msat)} until ${new Date(at).toLocaleString()}.`
      )
      setAmount('')
    })

  const pick = () => (
    <MintSelect
      mints={mints()}
      value={domain()}
      onChange={setDomain}
      balanceOf={d => w().balanceMsat(d)}
    />
  )

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
          aria-current={tab() === 'pay' ? 'page' : undefined}
          onClick={() => setTab('pay')}
        >
          Pay
        </button>
        <button
          aria-current={tab() === 'key' ? 'page' : undefined}
          onClick={() => setTab('key')}
        >
          To key
        </button>
        <button
          aria-current={tab() === 'lock' ? 'page' : undefined}
          onClick={() => setTab('lock')}
        >
          Lock
        </button>
      </nav>
      <section class="panel">
        <Show
          when={mints().length}
          fallback={<p class="quiet">Add a mint under Settings first.</p>}
        >
          <Switch>
            <Match when={tab() === 'note'}>
              <h2>Hand out a note</h2>
              <Show
                when={link()}
                fallback={
                  <>
                    <p class="quiet">
                      Whoever holds the link can redeem it, with any LNURL
                      wallet. You can take it back until they do.
                    </p>
                    {pick()}
                    <Field label="Amount (sat)">
                      <input
                        inputmode="numeric"
                        value={amount()}
                        onInput={e => setAmount(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Note to self (optional)">
                      <input
                        value={memo()}
                        onInput={e => setMemo(e.currentTarget.value)}
                      />
                    </Field>
                    <Action onClick={makeNote}>Make note</Action>
                  </>
                }
              >
                {value => (
                  <>
                    <NoteCard
                      value={value()}
                      design={w().snapshot.settings.design}
                    />
                    <p class="mono-break">{value()}</p>
                    <div class="row">
                      <Copy value={value()} label="Copy link" />
                      <button class="secondary" onClick={() => setLink(null)}>
                        Done
                      </button>
                    </div>
                  </>
                )}
              </Show>
            </Match>
            <Match when={tab() === 'pay'}>
              <h2>Pay</h2>
              <Show when={scanning()}>
                <Scanner
                  onScan={value => {
                    setScanning(false)
                    setTarget(value)
                  }}
                  onClose={() => setScanning(false)}
                />
              </Show>
              <Field label="Invoice, Lightning Address or LNURL">
                <textarea
                  value={target()}
                  onInput={e => {
                    setTarget(e.currentTarget.value)
                    setPay(null)
                  }}
                  spellcheck={false}
                />
              </Field>
              <Show when={props.platform.canScan && !scanning()}>
                <button class="link" onClick={() => setScanning(true)}>
                  Scan a QR code
                </button>
              </Show>
              <Switch>
                <Match when={invoiceMsat()}>
                  {msat => (
                    <>
                      {pick()}
                      <p>
                        Pays <span class="amount">{formatSats(msat())}</span>{' '}
                        from this mint.
                      </p>
                      <Action onClick={payNow}>Pay</Action>
                    </>
                  )}
                </Match>
                <Match when={pay()}>
                  {request => (
                    <>
                      <p>
                        {request().identifier ??
                          request().description ??
                          'Payee'}{' '}
                        <span class="quiet">
                          ({formatSats(request().minSendable)} to{' '}
                          {formatSats(request().maxSendable)})
                        </span>
                      </p>
                      {pick()}
                      <Show when={w().transferMint(request()) === domain()}>
                        <p class="good">
                          Same mint as the payee: this goes as an internal
                          transfer, no Lightning.
                        </p>
                      </Show>
                      <Field label="Amount (sat)">
                        <input
                          inputmode="numeric"
                          value={amount()}
                          onInput={e => setAmount(e.currentTarget.value)}
                        />
                      </Field>
                      <Action onClick={payNow}>Pay</Action>
                    </>
                  )}
                </Match>
                <Match
                  when={input()?.kind === 'lnurl' || input()?.kind === 'cp1'}
                >
                  <Action onClick={lookUp}>Continue</Action>
                </Match>
              </Switch>
            </Match>
            <Match when={tab() === 'key'}>
              <h2>Send to a note key</h2>
              <p class="quiet">
                Mints a note straight onto someone's key (a cp1) at your mint.
                Only they can spend it.
              </p>
              <Field label="Note key (cp1)">
                <input
                  value={key()}
                  onInput={e => setKey(e.currentTarget.value)}
                  spellcheck={false}
                />
              </Field>
              {pick()}
              <Field label="Amount (sat)">
                <input
                  inputmode="numeric"
                  value={amount()}
                  onInput={e => setAmount(e.currentTarget.value)}
                />
              </Field>
              <Action onClick={sendToKey}>Send</Action>
            </Match>
            <Match when={tab() === 'lock'}>
              <h2>Lock until a time</h2>
              <p class="quiet">
                Moves sats into a note only you can spend, and only from the
                time you pick. The mint enforces it by its own clock: a promise
                the mint keeps, not a trustless lock. Keep your wallet's
                records: a locked note is not found again from the words alone.
              </p>
              {pick()}
              <Field label="Amount (sat)">
                <input
                  inputmode="numeric"
                  value={amount()}
                  onInput={e => setAmount(e.currentTarget.value)}
                />
              </Field>
              <Field label="Unlocks at">
                <input
                  type="datetime-local"
                  value={until()}
                  onInput={e => setUntil(e.currentTarget.value)}
                />
              </Field>
              <Action onClick={lockNow}>Lock</Action>
            </Match>
          </Switch>
        </Show>
        <Busy />
      </section>
    </>
  )
}
