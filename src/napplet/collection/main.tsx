import {createSignal, createMemo, For, Show, onMount, onCleanup} from 'solid-js'
import {render} from 'solid-js/web'
import {getWalletHost} from '../host'
import type {WalletHost} from '../host'
import {installNutftShim} from '../../host/nutft-shim'
import {startCollectionWallet} from './bootstrap'
import {RESTORE_WAITING} from './session'
import type {CollectionSession, Opening} from './session'
import {buildCollectionView, filterStacks, scarcityRatio} from './cards'
import type {CardAsset, CardStack, CollectionView, Snapshot} from './cards'
import {issuedCounts, loadSupply} from './supply'
import type {SupplyChain} from './supply'
import {createFaceCache} from './faces'
import {EDITIONS} from './editions'
import {
  INVENTORY_CONVENTION,
  isInventoryRequest,
  publishInventory
} from './inventory'
import type {Inventory} from './inventory'
import {gatedSaleMessage, isGatedSaleRefusal} from './no-signer'
import {
  RECEIVE_CONVENTION,
  ReceiveProblem,
  readCardToken,
  receiveIntentToken,
  receiveProblem
} from './receive'
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
  accountWallets: boolean
}

const EDITION = __COLLECTION__
const TITLE = EDITIONS[EDITION.id]?.title ?? EDITION.id

/** A card is foil when the catalogue prints few of it. */
const FOIL_BELOW = 60

const when = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })

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
  const [sent, setSent] = createSignal<Array<{token: string; at?: string}>>([])
  const [mine, setMine] = createSignal('')
  const [supply, setSupply] = createSignal<SupplyChain | null>(null)
  const [supplyFault, setSupplyFault] = createSignal('')
  const [started, setStarted] = createSignal(false)
  const [checked, setChecked] = createSignal(0)
  const [restored, setRestored] = createSignal('')
  /* A restore the mint made wait continues by itself, and never blocks the
     rest of the collection while it waits. */
  const [restoreWaiting, setRestoreWaiting] = createSignal(false)
  let restoreTimer: ReturnType<typeof setTimeout> | undefined
  let restoreDelay = 15_000
  /* Cards held that are not yet on the account's own outputs. */
  const [unrestorable, setUnrestorable] = createSignal(0)
  /* The device's cards and the account: a move offered, or one that stopped
     and continues. Null when there is nothing to move. */
  const [move, setMove] = createSignal<{
    cards: number
    resume: boolean
  } | null>(null)
  const [elsewhere, setElsewhere] = createSignal(false)
  const [moving, setMoving] = createSignal('')
  const [moved, setMoved] = createSignal('')
  /* Receiving. The token lives in this signal and the field it fills, and is
     cleared the moment Redeem takes it. */
  const [receiving, setReceiving] = createSignal(false)
  const [token, setToken] = createSignal('')
  const [received, setReceived] = createSignal<{
    good: boolean
    text: string
  } | null>(null)
  const [copied, setCopied] = createSignal('')
  let tokenField: HTMLTextAreaElement | undefined
  let addressField: HTMLInputElement | undefined
  let receives: {close(): void} | undefined
  let tools: Promise<typeof import('@cashu/cashu-ts')> | null = null

  let session: CollectionSession | null = null
  let opening: Opening | null = null
  let storage: WalletHost['storage'] | null = null
  let inc: WalletHost['inc'] = undefined
  let inventory: Inventory | null = null
  let requests: {close(): void} | undefined
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

  /* Issued so far per card, from the verified ledger. Null until verified. */
  const issued = createMemo(() => {
    const chain = supply()
    return chain ? issuedCounts(chain.latest, catalog()) : null
  })

  const printedLine = (asset: CardAsset): string => {
    const count = issued()?.get(asset.asset_id)
    if (count) return `${count.issued} of ${count.copies} issued`
    return asset.copies ? `${asset.copies} printed` : 'uncapped'
  }

  /* The scarcity claim is checked separately from the cards. A chain that
     fails shows its reason and no issued counts; the cards stay, because
     they are proofs and the ledger is a claim. */
  const checkSupply = async (snapshot: Snapshot) => {
    const found = snapshot.catalog
    if (
      !storage ||
      !found?.issuer_pubkey ||
      !found.census_sha256 ||
      !found.collection_id ||
      !found.assets
    ) {
      setSupply(null)
      setSupplyFault(
        'The catalogue does not name its issuer, so supply cannot be checked.'
      )
      return
    }
    try {
      setSupply(
        await loadSupply({
          fetch: globalThis.fetch,
          storage,
          edition: EDITION,
          expect: {
            issuer: found.issuer_pubkey,
            collectionId: found.collection_id,
            censusSha256: found.census_sha256,
            catalogUri: found.catalog_uri,
            assets: found.assets
          }
        })
      )
      setSupplyFault('')
    } catch (error) {
      setSupply(null)
      setSupplyFault(error instanceof Error ? error.message : String(error))
    }
  }

  /* What other napplets may know: counts per card, never a proof. Kept by the
     shell so the host can answer for this napplet while it is closed, and
     announced so an open one hears it at once. An inventory that cannot be
     built or stored is withdrawn rather than left standing, and a fault here
     never blanks the cards already on screen. */
  const shareInventory = async (snapshot: Snapshot) => {
    if (!storage) return
    inventory = await publishInventory(
      {storage, inc},
      EDITION,
      snapshot,
      Math.floor(Date.now() / 1000)
    )
  }

  const refresh = async () => {
    if (!session) return
    setBusy('Reading the mint')
    try {
      const snapshot = await session.snapshot()
      setView(buildCollectionView(snapshot))
      setCatalog([...(snapshot.catalog?.assets ?? [])])
      setFailure('')
      setUnrestorable(
        session.active === 'host' ? (snapshot.unrestorable ?? 0) : 0
      )
      setSent(await session.sent())
      /* While the device's own wallet is on screen, the offer counts what it
         holds now, after a card came in or went out. */
      if (session.active === 'random')
        setMove(offer =>
          offer && !offer.resume
            ? {...offer, cards: snapshot.owned.length}
            : offer
        )
      await shareInventory(snapshot)
      await checkSupply(snapshot)
    } catch (error) {
      setFailure(readable(error))
    } finally {
      setBusy('')
    }
  }

  onMount(async () => {
    try {
      const host = getWalletHost()
      storage = host.storage
      inc = host.inc
      /* Another napplet asking for this edition's inventory gets the current
         one again. Any other payload on the topic, including this napplet's
         own announcements, is ignored, and the handler never throws: the
         shell's dispatch is not the place for this napplet's errors. */
      requests = inc?.on(INVENTORY_CONVENTION, event => {
        try {
          if (isInventoryRequest(event.payload, EDITION.id) && inventory)
            inc?.emit(INVENTORY_CONVENTION, inventory)
        } catch {
          /* ignored on purpose */
        }
      })
      const cashuModule = import('@cashu/cashu-ts')
      tools = cashuModule
      /* Another napplet may hand a card over. It is checked, then put in the
         field for the holder; nothing is redeemed until they press Redeem. */
      receives = inc?.on(RECEIVE_CONVENTION, event => {
        void stageReceive(event.payload)
      })
      shim = installNutftShim()
      /* One collection is open in one window. The lease is taken before any
         card is read, so a second window is told plainly instead of racing.
         It may carry the account's seed, and a malformed one stops here: the
         acquire refuses it and no wallet starts. A shell without the NutFT
         capability never answers at all, and is told so in those words
         rather than as a stored operation to reconcile. */
      const lease = await shim.acquire().catch((error: unknown) => {
        if (/timed out/i.test(error instanceof Error ? error.message : ''))
          throw new Error(
            "This shell did not answer the collection's mint capability " +
              '(nutft). Open the collection in a shell that offers it.'
          )
        throw error
      })
      session = await startCollectionWallet(EDITION, {
        storage: host.storage,
        nutft: shim,
        resource: host.resource,
        cashu: await cashuModule,
        walletCrypto: await (async () => {
          const [bip39, english, bip32] = await Promise.all([
            import('@scure/bip39'),
            import('@scure/bip39/wordlists/english.js'),
            import('@scure/bip32')
          ])
          return {...bip39, wordlist: english.wordlist, HDKey: bip32.HDKey}
        })(),
        seed: lease.seed,
        /* A restore asks the mint about a hundred card slots at a time. */
        observe: operation => {
          if (operation === 'restore') setChecked(count => count + 100)
        }
      })
      setStarted(true)
      /* The bootstrap replaced the global fetch with the collection router;
         the face cache goes through the same door as everything else. */
      faces = createFaceCache({fetch: globalThis.fetch})
      await begin()
    } catch (error) {
      setFailure(readable(error))
      setBusy('')
    }
  })

  /* Which wallet to show, and whether the account's cards have to come back
     from the mint first. Nothing here ever shows a word of the seed. "Try
     again" runs it once more until the collection is on screen. */
  const begin = async () => {
    if (!session) return
    setFailure('')
    try {
      if (!opening) {
        setBusy('Opening the collection')
        opening = await session.open()
        setElsewhere(opening.migration === 'elsewhere')
        if (opening.migration === 'offer' || opening.migration === 'resume')
          setMove({
            cards: opening.cards,
            resume: opening.migration === 'resume'
          })
      }
      if (opening.active === 'host' && opening.restore) await restoreAccount()
      setMine(await session.destination())
      await refresh()
      /* A move the holder already started carries on without asking twice. */
      if (opening.migration === 'resume' && move()) await moveCards()
    } catch (error) {
      setFailure(readable(error))
      setBusy('')
    }
  }

  const retry = () => (mine() ? refresh() : begin())

  /* Restore the account's cards. When the mint makes it wait, the collection
     says so, stays usable, and tries again later by itself, waiting longer
     each time up to five minutes. */
  const restoreAccount = async () => {
    if (!session) return
    setChecked(0)
    setBusy('Restoring your cards from the mint')
    try {
      const found = await session.restore()
      clearTimeout(restoreTimer)
      setRestoreWaiting(false)
      restoreDelay = 15_000
      if (opening) opening = {...opening, restore: false}
      if (found !== null)
        setRestored(
          found
            ? `Restored ${found} card${found === 1 ? '' : 's'} from the mint.`
            : 'Nothing to restore: this account holds no cards at this mint yet.'
        )
    } catch (error) {
      if (!(error instanceof Error) || error.message !== RESTORE_WAITING)
        throw error
      setRestoreWaiting(true)
      clearTimeout(restoreTimer)
      restoreTimer = setTimeout(() => void continueRestore(), restoreDelay)
      restoreDelay = Math.min(restoreDelay * 2, 300_000)
    } finally {
      setBusy('')
    }
  }

  const continueRestore = async () => {
    if (busy()) {
      restoreTimer = setTimeout(() => void continueRestore(), 5_000)
      return
    }
    try {
      await restoreAccount()
      if (!restoreWaiting()) await refresh()
    } catch (error) {
      setFailure(readable(error))
    }
  }

  /* One button, pressed on purpose. The wallet on screen changes only once
     the session says every card is confirmed under the account's key. */
  const moveCards = async () => {
    if (!session || busy()) return
    setFailure('')
    setBusy('Moving your cards to your account')
    try {
      const result = await session.migrate((done, total) =>
        setMoving(`${done} of ${total}`)
      )
      setMove(null)
      opening = {active: 'host', restore: false, migration: 'none', cards: 0}
      setMoved(
        `Moved ${result.moved} card${result.moved === 1 ? '' : 's'} to your account.` +
          (result.gone
            ? ` ${result.gone} had already left this device and could not be moved.`
            : '')
      )
      setMine(await session.destination())
      setBusy('')
      await refresh()
    } catch (error) {
      setMove(current => current && {...current, resume: true})
      setFailure(readable(error))
    } finally {
      setBusy('')
      setMoving('')
    }
  }

  onCleanup(() => {
    clearTimeout(restoreTimer)
    requests?.close()
    receives?.close()
    faces?.dispose()
    shim?.dispose()
  })

  const focusToken = () => queueMicrotask(() => tokenField?.focus())

  const openReceive = () => {
    setReceived(null)
    setReceiving(true)
    focusToken()
  }

  const closeReceive = () => {
    setReceiving(false)
    setToken('')
    setReceived(null)
    setCopied('')
  }

  /* A delivered card gets the same offline checks as a pasted one, and a card
     already waiting in the field is never replaced by the next one. */
  const stageReceive = async (payload: unknown) => {
    try {
      if (!tools) throw new ReceiveProblem('failed')
      const card = readCardToken(
        receiveIntentToken(payload),
        EDITION,
        await tools
      )
      if (token().trim()) throw new ReceiveProblem('waiting')
      setToken(card.token)
      setReceived(null)
    } catch (error) {
      setReceived({good: false, text: receiveProblem(error).message})
    }
    setReceiving(true)
    focusToken()
  }

  const redeem = async () => {
    const text = token()
    /* Cleared before anything can fail, whatever the outcome. */
    setToken('')
    if (tokenField) tokenField.value = ''
    setReceived(null)
    if (!session) return
    setBusy('Redeeming the card')
    try {
      const count = await session.receive(text)
      setReceived({
        good: true,
        text: `Received ${count} card${count === 1 ? '' : 's'}.`
      })
      setBusy('')
      await refresh()
    } catch (error) {
      setReceived({good: false, text: receiveProblem(error).message})
    } finally {
      setBusy('')
    }
  }

  const copyAddress = async () => {
    const address = mine()
    if (!address) return
    try {
      await navigator.clipboard.writeText(address)
      setCopied('Copied')
    } catch {
      /* A sandboxed frame is often refused the clipboard. The address is
         selected instead, so it can still be copied by hand. */
      addressField?.select()
      let done = false
      try {
        done = document.execCommand('copy')
      } catch {
        /* selected is the fallback */
      }
      setCopied(done ? 'Copied' : 'Selected')
    }
  }

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

  /* Every handed-over token comes back from storage, not from this loop: a
     handover that stops at the third card still shows the first two, and so
     does the next open, until the holder says they were passed on. */
  const hand = async () => {
    if (!session) return
    const chosen = selected()
    if (!chosen.length || !recipient().trim()) return
    setBusy('Handing over')
    setFailure('')
    let problem = ''
    try {
      for (const id of chosen) {
        const stack = view()?.stacks.find(s => s.asset.asset_id === id)
        const item = stack?.items[0] as {proof?: {secret?: string}} | undefined
        if (!item?.proof?.secret) continue
        await session.handOver(item.proof.secret, recipient().trim())
      }
      setSelected([])
      setSelecting(false)
    } catch (error) {
      problem = readable(error)
    }
    await refresh()
    if (problem) setFailure(problem)
  }

  const passedOn = async () => {
    if (!session) return
    try {
      await session.passedOn(sent().map(entry => entry.token))
      setSent(await session.sent())
    } catch (error) {
      setFailure(readable(error))
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
                <Show when={supply()}>
                  {chain => (
                    <div>
                      <dt>Packs issued</dt>
                      <dd>
                        {chain().latest.sold}
                        <span class="counters__of">
                          {' '}
                          of {chain().latest.packs}
                        </span>
                      </dd>
                    </div>
                  )}
                </Show>
              </dl>
            )}
          </Show>
        </header>

        <Show when={supply()}>
          {chain => (
            <p class="supply">
              Supply attested {when(chain().latest.at)}, snapshot{' '}
              {chain().latest.seq}, signed by the issuer and checked here.
            </p>
          )}
        </Show>
        <Show when={supplyFault()}>
          <p class="supply supply--bad" role="status">
            Supply unverified. {supplyFault()}
          </p>
        </Show>

        <Show when={failure()}>
          <div class="notice notice--bad" role="alert">
            <p>{failure()}</p>
            <Show when={started()}>
              <button class="button" onClick={retry} disabled={Boolean(busy())}>
                Try again
              </button>
            </Show>
          </div>
        </Show>

        <Show when={busy()}>
          <p class="notice" role="status">
            {busy()}
            <Show when={busy().startsWith('Restoring') && checked()}>
              , {checked()} card slots checked
            </Show>
            <Show when={busy().startsWith('Moving') && moving()}>
              , {moving()}
            </Show>
            …
          </p>
        </Show>

        <Show when={restored()}>
          <p class="notice notice--good" role="status">
            {restored()}
          </p>
        </Show>

        <Show when={restoreWaiting()}>
          <p class="notice" role="status">
            {RESTORE_WAITING}
          </p>
        </Show>

        <Show when={unrestorable()}>
          {count => (
            <p class="notice" role="status">
              {count()} card{count() === 1 ? ' is' : 's are'} not yet restorable
              from your account: {count() === 1 ? 'it has' : 'they have'} not
              been re-issued to your own key. The collection keeps trying on
              every refresh, and the card{count() === 1 ? ' stays' : 's stay'}{' '}
              yours meanwhile.
            </p>
          )}
        </Show>

        <Show when={move()}>
          {offer => (
            <div
              class="notice notice--move"
              role="region"
              aria-label="Move your cards to your account"
            >
              <p>
                <strong>Move your cards to your account.</strong>
              </p>
              <p>
                {offer().resume
                  ? 'Moving your cards to your account did not finish. It continues where it stopped; nothing is lost in between.'
                  : offer().cards
                    ? `This device holds ${offer().cards} card${offer().cards === 1 ? '' : 's'} in a wallet of its own. Moving them binds each card to your account, so your account brings them back on any device.`
                    : "This device's own wallet holds no cards now. Moving switches the collection to your account's wallet."}
              </p>
              <button
                class="button button--go"
                disabled={Boolean(busy())}
                onClick={moveCards}
              >
                {offer().resume ? 'Finish moving' : 'Move cards'}
              </button>
            </div>
          )}
        </Show>

        <Show when={elsewhere()}>
          <p class="notice" role="status">
            Some cards on this device are being moved to another account. Open
            this collection from that account to finish; nothing here touches
            them.
          </p>
        </Show>

        <Show when={moved()}>
          <p class="notice notice--good" role="status">
            {moved()}
          </p>
        </Show>

        <Show when={sent().length && !handover()}>
          <div class="notice" role="status">
            <p>
              {sent().length} handed-over card
              {sent().length === 1 ? ' is' : 's are'} waiting to be passed on.
              The tokens stay here until you say they were.
            </p>
            <button class="button" onClick={() => setHandover(true)}>
              Show them
            </button>
          </div>
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
                <button class="button" onClick={openReceive}>
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
                              {stack.asset.tier} · {printedLine(stack.asset)}
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
                      <Show when={issued()?.get(stack().asset.asset_id)}>
                        {count => (
                          <>
                            <dt>Issued</dt>
                            <dd>
                              {count().issued} of {count().copies}
                            </dd>
                          </>
                        )}
                      </Show>
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

      <Show when={receiving()}>
        <div
          class="sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Receive a card"
        >
          <div class="sheet__panel">
            <div class="sheet__head">
              <div>
                <p class="collection__kicker">Receive</p>
                <h2 class="sheet__title">Receive a card</h2>
              </div>
              <button class="button" onClick={closeReceive}>
                Close
              </button>
            </div>

            <label class="collection__kicker" for="collection-address">
              Your address in this collection
            </label>
            <div class="address">
              <input
                id="collection-address"
                ref={addressField}
                class="address__value"
                readonly
                value={mine() || 'not ready'}
              />
              <button class="button" disabled={!mine()} onClick={copyAddress}>
                {copied() || 'Copy'}
              </button>
            </div>
            <p>
              Give this to whoever is sending you a card. It names this wallet
              at this mint and nothing else.
            </p>

            <label class="collection__kicker" for="collection-token">
              Card token
            </label>
            <textarea
              id="collection-token"
              ref={tokenField}
              class="handover__token"
              placeholder="cashuB…"
              autocomplete="off"
              spellcheck={false}
              value={token()}
              onInput={event => {
                setToken(event.currentTarget.value)
                setReceived(null)
              }}
            />
            <div class="actions">
              <button
                class="button button--go"
                disabled={Boolean(busy()) || !started() || !token().trim()}
                onClick={redeem}
              >
                Redeem
              </button>
            </div>
            <Show when={received()}>
              {note => (
                <p
                  class={
                    note().good ? 'notice notice--good' : 'notice notice--bad'
                  }
                  role={note().good ? 'status' : 'alert'}
                >
                  {note().text}
                </p>
              )}
            </Show>
          </div>
        </div>
      </Show>

      <Show when={handover()}>
        <div
          class="sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Hand over"
        >
          <div class="sheet__panel">
            <div class="sheet__head">
              <div>
                <p class="collection__kicker">Handover</p>
                <h2 class="sheet__title">Hand over cards</h2>
              </div>
              <button class="button" onClick={() => setHandover(false)}>
                Close
              </button>
            </div>

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

            <Show when={sent().length}>
              <p class="collection__kicker">
                Handed over, waiting to be passed on
              </p>
              <textarea
                class="handover__token"
                readonly
                value={sent()
                  .map(entry => entry.token)
                  .join('\n\n')}
              />
              <p>
                Give these tokens to the recipient. Each one is the only way to
                claim its card, so they stay here, closed or not, until you say
                they were passed on.
              </p>
              <div class="actions">
                <button
                  class="button"
                  disabled={Boolean(busy())}
                  onClick={passedOn}
                >
                  They were passed on
                </button>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

render(() => <App />, document.getElementById('root')!)
