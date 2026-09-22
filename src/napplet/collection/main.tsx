import {
  createEffect,
  createSignal,
  createMemo,
  For,
  Show,
  onMount,
  onCleanup,
  untrack
} from 'solid-js'
import {render} from 'solid-js/web'
import {getWalletHost} from '../host'
import type {WalletHost} from '../host'
import {installNutftShim} from '../../host/nutft-shim'
import {startCollectionWallet} from './bootstrap'
import {MOVE_OPEN, RESTORE_WAITING} from './session'
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
  publishInventory,
  withdrawInventory
} from './inventory'
import type {Inventory} from './inventory'
import {gatedSaleMessage, isGatedSaleRefusal} from './no-signer'
import {
  RECEIVE_CONVENTION,
  WEBSITE_CARDS,
  isFinalRefusal,
  queueDelivery,
  readCardToken,
  receiveIntentToken,
  receiveProblem
} from './receive'
import {
  copyRefs,
  defaultPicks,
  handoverLines,
  pickedCopies,
  togglePick
} from './handover'
import {previewsFromSecrets} from './preview'
import type {CardPreview} from './preview'
import SessionBar from '../SessionBar'
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
  const [picks, setPicks] = createSignal<readonly string[]>([])
  const [preview, setPreview] = createSignal<CardPreview[]>([])
  const [codecReady, setCodecReady] = createSignal(0)
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
  /* The device's own wallet is on screen while a move of its cards is
     unfinished: it neither hands over nor receives until the move is done. */
  const [frozen, setFrozen] = createSignal(false)
  const [moving, setMoving] = createSignal('')
  const [moved, setMoved] = createSignal('')
  /* Receiving. The token lives in this signal and the field it fills. It
     leaves only once the card is in, after a refusal no second try can
     change, or when the holder confirms clearing it. */
  const [receiving, setReceiving] = createSignal(false)
  const [token, setToken] = createSignal('')
  /* Closing the receive sheet with a token still in the field asks first. */
  const [closing, setClosing] = createSignal(false)
  /* Cards other napplets handed over, waiting for the holder's turn. */
  const [deliveries, setDeliveries] = createSignal<readonly string[]>([])
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
  /* What was published, and the wallet it was counted from. */
  let inventory: {payload: Inventory; wallet: string} | null = null
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
  const shareInventory = async (snapshot: Snapshot, wallet: string) => {
    if (!storage || !session) return
    /* Counted from a wallet that is no longer on screen: published by no one. */
    if (session.wallet !== wallet) return dropInventory()
    const payload = await publishInventory(
      {storage, inc},
      EDITION,
      snapshot,
      Math.floor(Date.now() / 1000),
      wallet
    )
    inventory = payload && {payload, wallet}
  }

  /* Take the published inventory back until the wallet on screen has been
     read in full again: when the collection opens, perhaps for another
     account, when a refresh fails, and when the wallet on screen changes. */
  const dropInventory = async () => {
    inventory = null
    if (storage) await withdrawInventory({storage})
  }

  const refresh = async () => {
    if (!session) return
    setBusy('Reading the mint')
    try {
      const wallet = session.wallet
      const snapshot = await session.snapshot()
      setView(buildCollectionView(snapshot))
      setCatalog([...(snapshot.catalog?.assets ?? [])])
      setFailure('')
      setUnrestorable(
        session.active === 'host' ? (snapshot.unrestorable ?? 0) : 0
      )
      setSent(await session.sent())
      setFrozen(session.active === 'random' && (await session.moveUnfinished()))
      /* While the device's own wallet is on screen, the offer counts what it
         holds now, after a card came in or went out. */
      if (session.active === 'random')
        setMove(offer =>
          offer && !offer.resume
            ? {...offer, cards: snapshot.owned.length}
            : offer
        )
      await shareInventory(snapshot, wallet)
      await checkSupply(snapshot)
    } catch (error) {
      await dropInventory()
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
          if (
            isInventoryRequest(event.payload, EDITION.id) &&
            inventory &&
            inventory.wallet === session?.wallet
          )
            inc?.emit(INVENTORY_CONVENTION, inventory.payload)
        } catch {
          /* ignored on purpose */
        }
      })
      const cashuModule = import('@cashu/cashu-ts')
      tools = cashuModule
      void cashuModule.then(() => setCodecReady(count => count + 1))
      /* Another napplet may hand a card over. It is checked offline and waits
         in line; nothing is redeemed until the holder presses Redeem. */
      receives = inc?.on(RECEIVE_CONVENTION, event => {
        void deliver(event.payload)
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
      await dropInventory()
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
      setFrozen(false)
      /* Another wallet is on screen now; its own counts replace the old. */
      await dropInventory()
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
      const unfinished = await session.moveUnfinished().catch(() => true)
      setFrozen(session.active === 'random' && unfinished)
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

  const clearToken = () => {
    setToken('')
    if (tokenField) tokenField.value = ''
  }

  /* The holder is doing nothing a delivered card could get in the way of:
     nothing running, no card or handover sheet open, no move holding the
     wallet, and no token already in the field. */
  const idle = () =>
    started() &&
    !busy() &&
    !opened() &&
    !handover() &&
    !closing() &&
    !frozen() &&
    !token().trim()

  /* The oldest waiting card goes into the field, and only while idle. */
  const stageNext = () => {
    const [next, ...rest] = deliveries()
    if (!next || !idle()) return
    setDeliveries(rest)
    setToken(next)
    setReceived(null)
    setReceiving(true)
    focusToken()
  }

  createEffect(() => {
    if (idle() && deliveries().length) untrack(stageNext)
  })

  createEffect(() => {
    const text = token()
    const assets = catalog()
    codecReady()
    if (!tools || !text.trim()) {
      setPreview([])
      return
    }
    void tools.then(codec => {
      if (token() !== text) return
      try {
        const card = readCardToken(text, EDITION, codec)
        setPreview(
          previewsFromSecrets(
            card.proofs.map(proof => proof.secret),
            assets
          )
        )
      } catch {
        if (token() === text) setPreview([])
      }
    })
  })

  /* A delivered card gets the same offline checks as a pasted one. One that
     fails them is not the holder's business and is dropped without a word;
     one that passes waits its turn, and never replaces a token in the field. */
  const deliver = async (payload: unknown) => {
    try {
      if (!tools) return
      const card = readCardToken(
        receiveIntentToken(payload),
        EDITION,
        await tools
      )
      setDeliveries(waiting => queueDelivery(waiting, card.token, token()))
    } catch {
      /* not a card of this collection */
    }
  }

  const openReceive = () => {
    setReceived(null)
    setReceiving(true)
    stageNext()
    focusToken()
  }

  /* A token in the field is a card. Closing with one there asks first. */
  const closeReceive = (confirmed = false) => {
    if (token().trim() && !confirmed) {
      setClosing(true)
      return
    }
    setClosing(false)
    setReceiving(false)
    clearToken()
    setReceived(null)
    setCopied('')
  }

  const redeem = async () => {
    const text = token()
    if (!session || !text.trim()) return
    setReceived(null)
    setBusy('Redeeming the card')
    try {
      const count = await session.receive(text)
      if (token() === text) clearToken()
      setReceived({
        good: true,
        text: `Received ${count} card${count === 1 ? '' : 's'}.`
      })
      setBusy('')
      await refresh()
    } catch (error) {
      const problem = receiveProblem(error)
      /* Kept after any refusal a second try could change: the token is the
         card, and the holder may not have another copy. */
      if (isFinalRefusal(problem) && token() === text) clearToken()
      setReceived({good: false, text: problem.message})
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

  const chosenCopies = createMemo(() =>
    copyRefs(view()?.stacks ?? [], selected())
  )
  const openHandover = () => {
    setPicks(defaultPicks(chosenCopies()))
    setHandover(true)
  }

  /* Every handed-over token comes back from storage, not from this loop: a
     handover that stops at the third card still shows the first two, and so
     does the next open, until the holder says they were passed on. */
  const hand = async () => {
    if (!session) return
    const copies = pickedCopies(chosenCopies(), picks())
    if (!copies.length || !recipient().trim()) return
    setBusy('Handing over')
    setFailure('')
    let sentCount = 0
    let problem = ''
    try {
      for (const copy of copies) {
        try {
          await session.handOver(copy.secret, recipient().trim())
          sentCount += 1
        } catch (error) {
          problem = readable(error)
          break
        }
      }
    } catch (error) {
      problem = readable(error)
    }
    await refresh()
    setPicks([])
    setSelected([])
    setSelecting(false)
    if (problem)
      setFailure(
        sentCount
          ? `${sentCount} ${sentCount === 1 ? 'card' : 'cards'} left this collection. ${problem}`
          : problem
      )
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

  const barWaiting = (): string => {
    if (token().trim()) return 'Card waiting'
    if (handover() && picks().length) return 'Handover waiting'
    if (move()) return 'Move waiting'
    return ''
  }
  return (
    <div class="collection">
      <SessionBar
        surface="Collection"
        figure={
          view()
            ? `${view()!.counters.cards} ${view()!.counters.cards === 1 ? 'card' : 'cards'}`
            : TITLE
        }
        detail={TITLE}
        waiting={barWaiting()}
        onWaiting={() => {
          if (token().trim()) openReceive()
          else if (selected().length || handover()) openHandover()
          else openReceive()
        }}
      />
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
            them, and cards handed over are listed again once it has finished.
          </p>
        </Show>

        <Show when={frozen()}>
          <p class="notice" role="status">
            {MOVE_OPEN}
          </p>
        </Show>

        <Show when={moved()}>
          <p class="notice notice--good" role="status">
            {moved()}
          </p>
        </Show>

        <Show when={deliveries().length && !receiving()}>
          <div class="notice" role="status">
            <p>
              {deliveries().length} card
              {deliveries().length === 1 ? '' : 's'} handed over by other
              napplets {deliveries().length === 1 ? 'waits' : 'wait'} for you to
              redeem {deliveries().length === 1 ? 'it' : 'them'}.
            </p>
            <button class="button" disabled={frozen()} onClick={openReceive}>
              Show {deliveries().length === 1 ? 'it' : 'them'}
            </button>
          </div>
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
                  disabled={frozen()}
                  onClick={() => {
                    setSelecting(on => !on)
                    setSelected([])
                  }}
                >
                  {selecting() ? 'Selecting' : 'Select'}
                </button>
                <button
                  class="button button--go"
                  disabled={frozen() || !selected().length}
                  onClick={openHandover}
                >
                  Hand over
                </button>
                <button
                  class="button"
                  disabled={frozen()}
                  onClick={openReceive}
                >
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
                  disabled={frozen()}
                  onClick={() => {
                    setSelecting(true)
                    setSelected([stack().asset.asset_id])
                    setOpened(null)
                    setPicks(
                      defaultPicks(
                        copyRefs(view()?.stacks ?? [], [stack().asset.asset_id])
                      )
                    )
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
              <button class="button" onClick={() => closeReceive()}>
                Close
              </button>
            </div>

            <Show when={closing()}>
              <div class="notice notice--bad" role="alert">
                <p>
                  This card token is not redeemed. Closing clears it from the
                  collection, so keep a copy if you still want the card.
                </p>
                <div class="actions">
                  <button
                    class="button"
                    onClick={() => {
                      setClosing(false)
                      focusToken()
                    }}
                  >
                    Keep it
                  </button>
                  <button class="button" onClick={() => closeReceive(true)}>
                    Clear and close
                  </button>
                </div>
              </div>
            </Show>

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
            <p>{WEBSITE_CARDS}</p>

            <Show when={preview().length}>
              <ul class="preview">
                <For each={preview()}>
                  {card => (
                    <li>
                      <p class="preview__name">{card.name}</p>
                      <Show when={card.tier}>
                        <p class="preview__tier">{card.tier}</p>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
              <p>This is the card. Redeem keeps it in this collection.</p>
            </Show>

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
              disabled={Boolean(busy())}
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
            <Show when={deliveries().length}>
              <p class="mono">
                {deliveries().length} more card
                {deliveries().length === 1 ? '' : 's'} handed over by other
                napplets{' '}
                {deliveries().length === 1 ? 'waits its' : 'wait their'} turn
                here.
              </p>
            </Show>
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

            <Show when={chosenCopies().length}>
              <p class="collection__kicker">Choose the copies that leave</p>
              <ul class="preview">
                <For each={chosenCopies()}>
                  {copy => (
                    <li>
                      <label>
                        <input
                          type="checkbox"
                          checked={picks().includes(copy.y)}
                          onChange={() => setPicks(togglePick(picks(), copy.y))}
                        />{' '}
                        {copy.name}, copy {copy.index} of {copy.of}
                      </label>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={chosenCopies().length > 1}>
                <button
                  class="button"
                  onClick={() => setPicks(chosenCopies().map(copy => copy.y))}
                >
                  All copies
                </button>
              </Show>
              <For each={handoverLines(chosenCopies(), picks())}>
                {line => (
                  <p>
                    {line.name}: handing over {line.sending}. {line.staying}{' '}
                    {line.staying === 1 ? 'stays' : 'stay'} here.
                  </p>
                )}
              </For>
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
                  disabled={
                    Boolean(busy()) ||
                    frozen() ||
                    !recipient().trim() ||
                    !picks().length
                  }
                  onClick={hand}
                >
                  Hand over
                </button>
              </div>
              <p class="mono">
                The mint re-binds each chosen card to that address. Once it
                does, this collection no longer holds it.
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
