import {createSignal, createMemo, For, Show, onMount, onCleanup} from 'solid-js'
import {render} from 'solid-js/web'
import {getWalletHost} from '../host'
import {installNutftShim} from '../../host/nutft-shim'
import {startCollectionWallet} from './bootstrap'
import type {NutFTWalletApi} from './bootstrap'
import {buildCollectionView, filterStacks, scarcityRatio} from './cards'
import type {CardStack, CollectionView, Snapshot} from './cards'
import {createFaceCache} from './faces'
import {EDITIONS} from './editions'
import {gatedSaleMessage, isGatedSaleRefusal} from './no-signer'
import './collection.css'

/**
 * One collection, one napplet.
 *
 * The edition is compiled in rather than chosen at runtime, so this file never
 * asks which collection it is showing. `__COLLECTION__` is replaced by the
 * build; `src/napplet/collection/editions.ts` is where the values come from.
 */
declare const __COLLECTION__: {
  id: string
  mint: string
  units: string[]
  mirrors: string[]
}

const EDITION = __COLLECTION__
const TITLE = EDITIONS[EDITION.id]?.title ?? EDITION.id

/** A card is foil when the catalogue prints few of it. */
const FOIL_BELOW = 60

const truncate = (value: string, keep = 10): string =>
  value.length <= keep * 2 + 1
    ? value
    : `${value.slice(0, keep)}…${value.slice(-keep)}`

/**
 * What went wrong, in words a holder can act on.
 *
 * Two messages are rewritten rather than passed through. The shell check is
 * shared with the sats wallet and says "wallet", which is the wrong noun on a
 * screen full of cards. And the card library's answer to a gated mint tells the
 * reader to install a Nostr extension, which a napplet will not use.
 */
function readable(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (isGatedSaleRefusal(message)) return gatedSaleMessage()
  if (/napplet shell with storage and resource/i.test(message))
    return (
      'Open this collection in a napplet shell that offers storage and ' +
      'resources. Your cards are kept by the shell, not by this page.'
    )
  return message
}

function CardFace(props: {
  stack: CardStack
  faces: ReturnType<typeof createFaceCache>
}) {
  const [url, setUrl] = createSignal('')
  const [missing, setMissing] = createSignal(false)
  onMount(() => {
    props.faces
      .get(props.stack.asset.face)
      .then(setUrl)
      .catch(() => setMissing(true))
  })
  return (
    <div
      class="card__face"
      data-foil={String(props.stack.asset.copies < FOIL_BELOW)}
    >
      <Show
        when={url()}
        fallback={
          <span class="card__pending">{missing() ? 'no face' : 'loading'}</span>
        }
      >
        <img src={url()} alt={props.stack.asset.name} loading="lazy" />
      </Show>
      <Show when={props.stack.count > 1}>
        <span class="card__count">×{props.stack.count}</span>
      </Show>
    </div>
  )
}

function App() {
  const [failure, setFailure] = createSignal('')
  const [busy, setBusy] = createSignal('Opening the collection')
  const [view, setView] = createSignal<CollectionView | null>(null)
  const [catalog, setCatalog] = createSignal<CardStack['asset'][]>([])
  const [search, setSearch] = createSignal('')
  const [tier, setTier] = createSignal('')
  const [type, setType] = createSignal('')
  const [duplicatesOnly, setDuplicatesOnly] = createSignal(false)
  const [opened, setOpened] = createSignal<CardStack | null>(null)
  const [turned, setTurned] = createSignal(false)
  const [selecting, setSelecting] = createSignal(false)
  const [selected, setSelected] = createSignal<readonly string[]>([])
  const [handover, setHandover] = createSignal(false)
  const [recipient, setRecipient] = createSignal('')
  const [handedOver, setHandedOver] = createSignal('')
  const [mine, setMine] = createSignal('')

  let wallet: NutFTWalletApi | null = null
  let faces: ReturnType<typeof createFaceCache> | null = null
  let shim: ReturnType<typeof installNutftShim> | null = null

  const shown = createMemo(() =>
    filterStacks(view()?.stacks ?? [], {
      search: search(),
      tier: tier(),
      type: type(),
      duplicatesOnly: duplicatesOnly()
    })
  )

  const refresh = async () => {
    if (!wallet) return
    setBusy('Reading the mint')
    try {
      const snapshot = (await wallet.snapshot(EDITION.mint)) as Snapshot
      setView(buildCollectionView(snapshot))
      setCatalog([...(snapshot.catalog?.assets ?? [])])
      setFailure('')
    } catch (error) {
      setFailure(readable(error))
    } finally {
      setBusy('')
    }
  }

  onMount(async () => {
    try {
      const host = getWalletHost()
      shim = installNutftShim()
      /* One collection is open in one window. The lease is taken before any
         card is read, so a second window is told plainly instead of racing. */
      await shim.acquire()
      const fetcher = {current: null as typeof fetch | null}
      wallet = await startCollectionWallet(EDITION, {
        storage: host.storage,
        nutft: shim,
        resource: host.resource,
        cashu: await import('@cashu/cashu-ts'),
        walletCrypto: await (async () => {
          const [bip39, english, bip32] = await Promise.all([
            import('@scure/bip39'),
            import('@scure/bip39/wordlists/english.js'),
            import('@scure/bip32')
          ])
          return {...bip39, wordlist: english.wordlist, HDKey: bip32.HDKey}
        })()
      })
      /* The bootstrap replaced the global fetch with the collection router;
         the face cache goes through the same door as everything else. */
      fetcher.current = globalThis.fetch
      faces = createFaceCache({fetch: fetcher.current})
      setMine(String(await wallet.destination()))
      await refresh()
    } catch (error) {
      setFailure(readable(error))
      setBusy('')
    }
  })

  onCleanup(() => {
    faces?.dispose()
    shim?.dispose()
  })

  const toggle = (stack: CardStack) => {
    const id = stack.asset.asset_id
    setSelected(list =>
      list.includes(id) ? list.filter(other => other !== id) : [...list, id]
    )
  }

  const open = (stack: CardStack) => {
    if (selecting()) return toggle(stack)
    setTurned(false)
    setOpened(stack)
  }

  const hand = async () => {
    if (!wallet) return
    const chosen = selected()
    if (!chosen.length || !recipient().trim()) return
    setBusy('Handing over')
    setFailure('')
    try {
      const tokens: string[] = []
      for (const id of chosen) {
        const stack = view()?.stacks.find(s => s.asset.asset_id === id)
        const item = stack?.items[0] as {proof?: {secret?: string}} | undefined
        if (!item?.proof?.secret) continue
        const result = (await wallet.tradeProof(
          EDITION.mint,
          item.proof.secret,
          recipient().trim()
        )) as {token?: string}
        if (result?.token) tokens.push(result.token)
      }
      setHandedOver(tokens.join('\n\n'))
      setSelected([])
      setSelecting(false)
      await refresh()
    } catch (error) {
      setFailure(readable(error))
    } finally {
      setBusy('')
    }
  }

  return (
    <div class="collection">
      <p class="collection__ghost" aria-hidden="true">
        {EDITION.units[0] ?? TITLE}
      </p>
      <div class="collection__inner">
        <header class="collection__head">
          <div>
            <p class="collection__kicker">Collection</p>
            <h1 class="collection__title">{TITLE}</h1>
          </div>
          <Show when={view()}>
            {v => (
              <dl class="counters">
                <div>
                  <dt>Cards</dt>
                  <dd>{v().counters.cards}</dd>
                </div>
                <div>
                  <dt>Distinct</dt>
                  <dd>{v().counters.distinct}</dd>
                </div>
                <div>
                  <dt>Duplicates</dt>
                  <dd>{v().counters.duplicates}</dd>
                </div>
              </dl>
            )}
          </Show>
        </header>

        <Show when={failure()}>
          <div class="notice notice--bad" role="alert">
            <p>{failure()}</p>
            <button class="button" onClick={refresh} disabled={Boolean(busy())}>
              Try again
            </button>
          </div>
        </Show>

        <Show when={busy()}>
          <p class="notice" role="status">
            {busy()}…
          </p>
        </Show>

        <Show when={view()}>
          {v => (
            <>
              <div class="console">
                <input
                  type="search"
                  placeholder="Search name, type or id"
                  value={search()}
                  onInput={event => setSearch(event.currentTarget.value)}
                  aria-label="Search this collection"
                />
                <select
                  value={tier()}
                  onChange={event => setTier(event.currentTarget.value)}
                  aria-label="Tier"
                >
                  <option value="">All tiers</option>
                  <For each={v().tiers}>
                    {name => <option value={name}>{name}</option>}
                  </For>
                </select>
                <select
                  value={type()}
                  onChange={event => setType(event.currentTarget.value)}
                  aria-label="Type"
                >
                  <option value="">All types</option>
                  <For each={v().types}>
                    {name => <option value={name}>{name}</option>}
                  </For>
                </select>
                <button
                  class="button"
                  aria-pressed={duplicatesOnly()}
                  onClick={() => setDuplicatesOnly(on => !on)}
                >
                  Duplicates
                </button>
                <button
                  class="button"
                  aria-pressed={selecting()}
                  onClick={() => {
                    setSelecting(on => !on)
                    setSelected([])
                  }}
                >
                  {selecting() ? 'Selecting' : 'Select'}
                </button>
                <button
                  class="button button--go"
                  disabled={!selected().length}
                  onClick={() => setHandover(true)}
                >
                  Hand over{selected().length ? ` (${selected().length})` : ''}
                </button>
                <button class="button" onClick={() => setHandover(true)}>
                  Receive
                </button>
              </div>

              <Show
                when={shown().length}
                fallback={
                  <div class="empty">
                    <h2>
                      {v().counters.cards ? 'Nothing matches' : 'No cards yet'}
                    </h2>
                    <p>
                      {v().counters.cards
                        ? 'Clear the filters to see the rest of the collection.'
                        : 'Cards you receive appear here, rarest first.'}
                    </p>
                  </div>
                }
              >
                <ul class="grid">
                  <For each={shown()}>
                    {stack => (
                      <li>
                        <button
                          class="card"
                          aria-pressed={
                            selecting()
                              ? selected().includes(stack.asset.asset_id)
                              : undefined
                          }
                          onClick={() => open(stack)}
                        >
                          <Show when={faces}>
                            {cache => (
                              <CardFace stack={stack} faces={cache()} />
                            )}
                          </Show>
                          <div class="card__meta">
                            <p class="card__name">{stack.asset.name}</p>
                            <p class="card__tier">
                              {stack.asset.tier} · {stack.asset.copies} printed
                            </p>
                          </div>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>

              <Show
                when={v().notShown.invalid || v().notShown.unreadable}
                keyed
              >
                <div class="notice">
                  <p>
                    <strong>Not shown.</strong> {v().notShown.unreadable} token
                    {v().notShown.unreadable === 1 ? '' : 's'} this mint cannot
                    open, which usually means another collection, and{' '}
                    {v().notShown.invalid} it opened and rejected. Nothing was
                    deleted.
                  </p>
                  <Show when={v().notShown.reasons.length}>
                    <ul class="notice__reasons">
                      <For each={v().notShown.reasons}>
                        {reason => <li>{reason}</li>}
                      </For>
                    </ul>
                  </Show>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>

      <Show when={opened()}>
        {stack => (
          <div
            class="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={stack().asset.name}
          >
            <div class="sheet__panel">
              <div class="sheet__head">
                <div>
                  <p class="collection__kicker">{stack().asset.tier}</p>
                  <h2 class="sheet__title">{stack().asset.name}</h2>
                </div>
                <button class="button" onClick={() => setOpened(null)}>
                  Close
                </button>
              </div>

              <div class="flipper" data-turned={String(turned())}>
                <div class="flipper__inner">
                  <div class="flipper__side">
                    <Show when={faces}>
                      {cache => <CardFace stack={stack()} faces={cache()} />}
                    </Show>
                  </div>
                  <div class="flipper__side flipper__side--back">
                    <dl class="facts">
                      <dt>Edition</dt>
                      <dd>{view()?.collectionId ?? EDITION.units[0]}</dd>
                      <dt>Asset</dt>
                      <dd>{stack().asset.asset_id}</dd>
                      <dt>Type</dt>
                      <dd>{stack().asset.type_line}</dd>
                      <dt>Printed</dt>
                      <dd>
                        {stack().asset.copies}
                        <Show when={scarcityRatio(stack().asset, catalog())}>
                          {ratio => <> · one in {ratio()}</>}
                        </Show>
                      </dd>
                      <dt>Held</dt>
                      <dd>{stack().count}</dd>
                      <dt>Binding</dt>
                      <dd>{truncate(stack().asset.asset_binding)}</dd>
                      <dt>Face</dt>
                      <dd class="checked">
                        {truncate(stack().asset.face.sha256)} checked
                      </dd>
                      <dt>At the mint</dt>
                      <dd>{stack().items[0]?.state ?? 'unknown'}</dd>
                    </dl>
                  </div>
                </div>
              </div>

              <div class="actions">
                <button class="button" onClick={() => setTurned(on => !on)}>
                  {turned() ? 'Front' : 'Provenance'}
                </button>
                <button
                  class="button"
                  onClick={() => {
                    setSelecting(true)
                    setSelected([stack().asset.asset_id])
                    setOpened(null)
                    setHandover(true)
                  }}
                >
                  Hand this over
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={handover()}>
        <div
          class="sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Handover"
        >
          <div class="sheet__panel">
            <div class="sheet__head">
              <div>
                <p class="collection__kicker">Handover</p>
                <h2 class="sheet__title">Give and receive</h2>
              </div>
              <button
                class="button"
                onClick={() => {
                  setHandover(false)
                  setHandedOver('')
                }}
              >
                Close
              </button>
            </div>

            <p class="collection__kicker">Your address in this collection</p>
            <p class="mono">{mine() || 'not ready'}</p>
            <p>
              Give this to whoever is sending you a card. It names this wallet
              at this mint and nothing else.
            </p>

            <Show when={selected().length}>
              <p class="collection__kicker">
                Handing over {selected().length} card
                {selected().length === 1 ? '' : 's'}
              </p>
              <input
                type="search"
                class="handover__input"
                placeholder="Recipient address from their wallet"
                value={recipient()}
                onInput={event => setRecipient(event.currentTarget.value)}
                aria-label="Recipient address"
              />
              <div class="actions">
                <button
                  class="button button--go"
                  disabled={Boolean(busy()) || !recipient().trim()}
                  onClick={hand}
                >
                  Hand over
                </button>
              </div>
              <p class="mono">
                The mint re-binds each card to that address. Once it does, this
                wallet no longer holds it.
              </p>
            </Show>

            <Show when={handedOver()}>
              <p class="collection__kicker">Handed over</p>
              <textarea class="handover__token" readonly>
                {handedOver()}
              </textarea>
              <p>
                The recipient can also import this token directly if their
                wallet asks for one.
              </p>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

render(() => <App />, document.getElementById('root')!)
