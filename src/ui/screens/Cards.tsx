// The 600B cards this wallet holds (docs/CARDS-LNURLCASH.md): buying a
// pack, the collection, a card address to be given cards at, and handing a
// card on. The TCG reads only the counts, through the Hangar.
import {createMemo, createSignal, For, Show} from 'solid-js'
import {Action, Busy, Copy, Field, MintSelect, Qr} from '../kit.tsx'
import {formatSats} from '../format.ts'
import {notify, run} from '../session.ts'
import type {Wallet} from '../../wallet/wallet.ts'

type Invoice = {pr: string; verify?: string; amountMsat: number}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const Cards = (props: {wallet: () => Wallet}) => {
  const w = () => props.wallet()
  const cardMints = () =>
    Object.values(w().snapshot.cardMints).sort((a, b) => a.addedAt - b.addedAt)
  const mints = () => Object.values(w().snapshot.mints)
  const [picked, setPicked] = createSignal('')
  const current = () => picked() || cardMints()[0]?.domain || ''
  const [address, setAddress] = createSignal('')
  const [invoice, setInvoice] = createSignal<Invoice | null>(null)
  const [payFrom, setPayFrom] = createSignal('')
  const [mine, setMine] = createSignal<string | null>(null)
  const [handing, setHanding] = createSignal<string | null>(null)
  const [to, setTo] = createSignal('')

  /** The held cards at the current card mint, grouped by card. */
  const collection = createMemo(() => {
    const groups = new Map<string, {id: string; serial: string}[]>()
    for (const card of w().cards({mint: current(), status: 'held'})) {
      const {head} = w().verifiedCard(card.id)
      const serial = head.description.split('#').pop() ?? ''
      groups.set(head.name, [
        ...(groups.get(head.name) ?? []),
        {id: card.id, serial}
      ])
    }
    return [...groups.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
  })
  const moving = () => w().cards({mint: current(), status: 'moving'})
  const richest = () =>
    [...mints()].sort(
      (a, b) => w().balanceMsat(b.domain) - w().balanceMsat(a.domain)
    )[0]?.domain ?? ''

  const addCardMint = () =>
    run('Adding the card mint', async () => {
      const record = await w().addCardMint(address())
      setPicked(record.domain)
      setAddress('')
      const found = await w().refreshCards(record.domain, true)
      notify(found ? `Found ${found} of your cards.` : 'Card mint added.')
    })

  const refresh = (scan = false) =>
    run(
      scan ? 'Scanning for your cards' : 'Asking for your cards',
      async () => {
        const found = await w().refreshCards(current(), scan)
        notify(`${found} ${found === 1 ? 'card' : 'cards'} at this card mint.`)
      }
    )

  const buyPack = () =>
    run('Asking for a pack', async () => {
      setInvoice(await w().requestPack(current()))
      setPayFrom(richest())
    })

  /** Waits for the pack's invoice to settle, then fetches its cards. */
  const collect = async (bill: Invoice) => {
    if (!bill.verify) return notify('Refresh once the pack is paid.')
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await w().packPaid(bill.verify)) {
        await w().refreshCards(current())
        setInvoice(null)
        return notify('Your pack is here.')
      }
      await sleep(3000)
    }
    notify('The pack is not paid yet. Refresh once it is.')
  }

  const payPack = () =>
    run('Paying for the pack', async () => {
      const bill = invoice()
      if (!bill) return
      await w().pay(payFrom(), bill.pr)
      await collect(bill)
    })

  const paidElsewhere = () =>
    run('Waiting for the payment', async () => {
      const bill = invoice()
      if (bill) await collect(bill)
    })

  const showAddress = () =>
    run('Making a card address', async () => {
      setMine(await w().cardAddress(current()))
    })

  const handOn = (id: string) =>
    run('Handing the card on', async () => {
      await w().sendCard(id, to())
      setHanding(null)
      setTo('')
      notify('Card sent.')
    })

  return (
    <section class="panel">
      <h2>Cards</h2>
      <Show
        when={cardMints().length}
        fallback={
          <p class="quiet">
            Cards of the 600B Timelock TCG live at a card mint, as notes only
            your keys can move. Add one to buy packs and hold cards.
          </p>
        }
      >
        <Show when={cardMints().length > 1}>
          <Field label="Card mint">
            <select
              value={current()}
              onChange={e => setPicked(e.currentTarget.value)}
            >
              <For each={cardMints()}>
                {record => (
                  <option value={record.domain}>{record.domain}</option>
                )}
              </For>
            </select>
          </Field>
        </Show>
        <Show
          when={collection().length}
          fallback={<p class="quiet">No cards here yet.</p>}
        >
          <ul class="list">
            <For each={collection()}>
              {([name, copies]) => (
                <li>
                  <div class="row">
                    <span>{name}</span>
                    <span class="quiet">
                      ×{copies.length} · #
                      {copies.map(c => c.serial).join(', #')}
                    </span>
                  </div>
                  <For each={copies}>
                    {copy => (
                      <Show
                        when={handing() === copy.id}
                        fallback={
                          <button
                            class="link"
                            onClick={() => setHanding(copy.id)}
                          >
                            Hand on #{copy.serial}
                          </button>
                        }
                      >
                        <Field label="Their card address (cp1)">
                          <input
                            value={to()}
                            onInput={e => setTo(e.currentTarget.value)}
                            spellcheck={false}
                          />
                        </Field>
                        <div class="row">
                          <Action onClick={() => handOn(copy.id)}>Send</Action>
                          <button
                            class="secondary"
                            onClick={() => setHanding(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </Show>
                    )}
                  </For>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={moving().length}>
          <p class="quiet">
            {moving().length} on the way: the card mint has not answered yet.
            Bearlett asks again.
          </p>
        </Show>
        <div class="row">
          <Action onClick={buyPack}>Buy a pack</Action>
          <Action kind="secondary" onClick={showAddress}>
            My card address
          </Action>
          <Action kind="secondary" onClick={() => refresh()}>
            Refresh
          </Action>
        </div>
        <button class="link" onClick={() => refresh(true)}>
          Scan for my cards
        </button>
        <Show when={invoice()}>
          {bill => (
            <>
              <h3>A pack for {formatSats(bill().amountMsat)}</h3>
              <Qr value={bill().pr} />
              <div class="row">
                <Copy value={bill().pr} label="Copy invoice" />
              </div>
              <Show when={mints().length}>
                <MintSelect
                  mints={mints()}
                  value={payFrom()}
                  onChange={setPayFrom}
                  balanceOf={d => w().balanceMsat(d)}
                />
                <Action onClick={payPack}>Pay from this wallet</Action>
              </Show>
              <button class="link" onClick={paidElsewhere}>
                I paid it elsewhere
              </button>
            </>
          )}
        </Show>
        <Show when={mine()}>
          {cp1 => (
            <>
              <h3>Your card address</h3>
              <p class="quiet">
                Give it to whoever hands you a card. A fresh one every time
                keeps your cards apart.
              </p>
              <Qr value={cp1()} />
              <p class="mono-break">{cp1()}</p>
              <Copy value={cp1()} label="Copy address" />
            </>
          )}
        </Show>
      </Show>
      <Field label="Add a card mint">
        <input
          value={address()}
          placeholder="tcg.nappelin.com"
          onInput={e => setAddress(e.currentTarget.value)}
          spellcheck={false}
        />
      </Field>
      <Action
        kind={cardMints().length ? 'secondary' : 'primary'}
        onClick={addCardMint}
      >
        Add card mint
      </Action>
      <Busy />
    </section>
  )
}
