import {createSignal, createEffect, For, Show} from 'solid-js'
import type {Bearlett} from './bearlett'
import {Transfers} from './transfers'
import type {Protocol, Transfer} from './transfers'
import type {CashuJournal} from './cashu/state'
import type {Note} from './vault'

/** Protocol-independent transfers and recovery details live inside the wallet's existing tool sections. */
export default function BearlettTools(props: {
  tab: string
  wallet: Bearlett
  notes: Note[]
  selected: string[]
  revision: number
  busy: boolean
  run(action: () => Promise<void>): Promise<void>
}) {
  const [phrase, setPhrase] = createSignal(''),
    [mint, setMint] = createSignal('')
  const [target, setTarget] = createSignal<Protocol>('cashu'),
    [amount, setAmount] = createSignal('')
  const [enabled, setEnabled] = createSignal(false),
    [operations, setOperations] = createSignal<CashuJournal[]>([])
  const [transfers, setTransfers] = createSignal<Transfer[]>([])
  const coordinator = new Transfers(props.wallet.vault, props.wallet.cashu)
  createEffect(() => {
    props.revision
    void (async () => {
      const state =
        await props.wallet.vault.meta<import('./cashu/state').CashuState>(
          'cashu-v1'
        )
      setEnabled(!!state)
      setOperations(state?.operations ?? [])
      setTransfers(await coordinator.list())
    })().catch(() => {
      setEnabled(false)
      setOperations([])
      setTransfers([])
    })
  })
  const run = (fn: () => Promise<void>) => void props.run(fn)
  const source = () =>
    props.notes.find(n => props.selected.includes(n.id))?.protocol ??
    'lnurlcash'
  const fee = (op: CashuJournal) => {
    const q = op?.quote
    return q ? Number(q.fee_reserve ?? 0) : 0
  }
  return (
    <>
      <Show
        when={['recovery', 'mint', 'receive'].includes(props.tab) && !enabled()}
      >
        <section class="panel">
          <p class="eyebrow">ONE WALLET · TWO PROTOCOLS</p>
          <h2>Enable Cashu</h2>
          <p>
            Use this wallet’s recovery phrase to add Cashu with its own key
            derivation.
          </p>
          <label>
            Existing recovery phrase
            <textarea
              autocomplete="off"
              value={phrase()}
              onInput={e => setPhrase(e.currentTarget.value)}
            />
          </label>
          <button
            disabled={props.busy || !props.wallet.cashu.host || !phrase()}
            onClick={() =>
              run(async () => {
                await props.wallet.cashu.enable(phrase())
                setPhrase('')
              })
            }
          >
            Enable Cashu
          </button>
          <Show when={!props.wallet.cashu.host}>
            <p>
              This shell needs the Bearlett Cashu capability. Your LNURLcash
              wallet is available.
            </p>
          </Show>
        </section>
      </Show>
      <Show when={props.tab === 'recovery' && enabled()}>
        <section class="panel">
          <h2>Recover Cashu from your seed</h2>
          <p>
            Scan each mint you used before creating new proofs with a restored
            seed. Keep full backups for unpaid invoices and open transfers.
          </p>
          <label>
            Cashu mint URL
            <input
              value={mint()}
              placeholder="https://mint.example"
              onInput={e => setMint(e.currentTarget.value)}
            />
          </label>
          <button
            disabled={props.busy || !mint()}
            onClick={() =>
              run(async () => {
                await props.wallet.cashu.recover(mint())
              })
            }
          >
            Scan Cashu mint
          </button>
        </section>
      </Show>
      <Show when={props.tab === 'transfer'}>
        <section class="panel">
          <p class="eyebrow">YOUR SATS, WHERE YOU WANT THEM</p>
          <h2>Move between mints</h2>
          <p>
            Select source notes in your collection. Bearlett connects LNURLcash
            and Cashu through Lightning.
          </p>
          <p>
            <strong>{props.selected.length} selected</strong> ·{' '}
            {source() === 'cashu' ? 'Cashu' : 'LNURLcash'}
          </p>
          <label>
            Destination protocol
            <select
              value={target()}
              onChange={e => setTarget(e.currentTarget.value as Protocol)}
            >
              <option value="cashu">Cashu</option>
              <option value="lnurlcash">LNURLcash</option>
            </select>
          </label>
          <label>
            Destination mint
            <input
              placeholder="https://mint.example"
              value={mint()}
              onInput={e => setMint(e.currentTarget.value)}
            />
          </label>
          <label>
            Lightning amount (whole sats)
            <input
              inputmode="numeric"
              value={amount()}
              onInput={e => setAmount(e.currentTarget.value)}
            />
          </label>
          <p class="hint">
            The destination may deduct a mint fee. Preparing source notes can
            incur split or swap fees. Review the stored quote before paying.
          </p>
          <button
            disabled={
              props.busy || !props.selected.length || !mint() || !amount()
            }
            onClick={() =>
              run(async () => {
                await coordinator.prepare(
                  source(),
                  props.selected,
                  target(),
                  mint(),
                  Number(amount()) * 1000
                )
              })
            }
          >
            Prepare transfer
          </button>
        </section>
      </Show>
      <Show
        when={
          ['transfer', 'activity', 'wallet'].includes(props.tab) &&
          transfers().some(t => t.phase !== 'complete')
        }
      >
        <section class="panel">
          <h2>Transfers in progress</h2>
          <For each={transfers().filter(t => t.phase !== 'complete')}>
            {t => (
              <div class="transfer-record">
                <p>
                  <strong>{t.amountMsat / 1000} sats</strong> · {t.source} →{' '}
                  {t.target}
                </p>
                <p>{t.mint}</p>
                <span class="badge">{t.phase}</span>
                <Show when={t.phase === 'quoted'}>
                  <p>
                    Destination invoice: {t.amountMsat / 1000} sats.{' '}
                    {t.source === 'cashu'
                      ? `Routing reserve: ${fee(operations().find(o => o.id === t.paymentId)!)} sats.`
                      : 'Prepared source note exactly matches the invoice.'}
                  </p>
                  <p>
                    Expected destination value:{' '}
                    {(t.expectedTargetMsat ?? t.amountMsat) / 1000} sats ·
                    maximum source debit:{' '}
                    {t.maximumDebitMsat === undefined
                      ? 'unknown'
                      : t.maximumDebitMsat / 1000}{' '}
                    sats
                  </p>
                  <Show when={t.preparationFeeMsat}>
                    <p>
                      Source preparation fee: {t.preparationFeeMsat! / 1000}{' '}
                      sats (already incurred).
                    </p>
                  </Show>
                  <button
                    class="primary"
                    disabled={props.busy}
                    onClick={() => run(() => coordinator.confirm(t.id))}
                  >
                    Confirm transfer
                  </button>
                </Show>
                <Show when={['funding', 'claiming'].includes(t.phase)}>
                  <button
                    disabled={props.busy}
                    onClick={() => run(() => coordinator.resume(t.id))}
                  >
                    Check and continue transfer
                  </button>
                </Show>
                <Show when={t.phase === 'preparing'}>
                  <p>
                    Preparation was interrupted. Its notes and quotes remain in
                    this wallet. Inspect pending operations before preparing
                    another transfer.
                  </p>
                </Show>
              </div>
            )}
          </For>
        </section>
      </Show>
      <Show
        when={
          ['activity', 'wallet', 'pay', 'mint'].includes(props.tab) &&
          operations().some(o => o.phase !== 'complete')
        }
      >
        <section class="panel">
          <h2>Cashu operations</h2>
          <For each={operations().filter(o => o.phase !== 'complete')}>
            {op => (
              <div class="transfer-record">
                <p>
                  <strong>
                    {op.kind === 'mint'
                      ? 'Receive funding'
                      : op.kind === 'melt'
                        ? 'Lightning payment'
                        : 'Secure bearer notes'}
                  </strong>{' '}
                  · {new URL(op.mint).host}
                </p>
                <span class="badge">{op.phase}</span>
                <Show when={op.invoice}>
                  <details>
                    <summary>Stored invoice</summary>
                    <textarea readonly value={op.invoice} />
                  </details>
                </Show>
                <Show when={op.kind === 'melt' && op.phase === 'prepared'}>
                  <p>
                    Invoice: {Number(op.quote?.amount)} sats · routing reserve:{' '}
                    {fee(op)} sats
                  </p>
                  <p>
                    Mint input fee: {op.inputFee ?? 'unknown'} sats · maximum
                    debit: {op.maximumDebit ?? 'unknown'} sats
                  </p>
                  <p>
                    Source notes are reserved. Unused value returns as Cashu
                    change.
                  </p>
                  <Show when={!transfers().some(t => t.paymentId === op.id)}>
                    <button
                      class="primary"
                      disabled={props.busy}
                      onClick={() => run(() => props.wallet.cashu.pay(op.id))}
                    >
                      Confirm Cashu payment
                    </button>
                    <button
                      disabled={props.busy}
                      onClick={() =>
                        run(() => props.wallet.cashu.cancel(op.id))
                      }
                    >
                      Cancel unsubmitted payment
                    </button>
                  </Show>
                </Show>
                <Show when={op.kind !== 'melt' || op.phase !== 'prepared'}>
                  <button
                    disabled={props.busy}
                    onClick={() => run(() => props.wallet.cashu.resume(op.id))}
                  >
                    Check and recover
                  </button>
                </Show>
              </div>
            )}
          </For>
        </section>
      </Show>
    </>
  )
}
