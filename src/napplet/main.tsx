import {createSignal, For, Show, onMount, onCleanup} from 'solid-js'
import {render} from 'solid-js/web'
import {QRCodeSVG, ErrorCorrectionLevel} from 'solid-qr-code'
import {getWalletHost} from './host'
import {Vault} from './vault'
import type {Note} from './vault'
import {Wallet} from './wallet'
import {listenWalletIntents} from './intents'
import type {WalletRequest} from './intents'
import {decodeBolt11AmountMsat, serverOf} from '../lnurlcash'
import Banknote from './Banknote'
import {
  DEFAULT_DESIGN,
  DESIGN_TOPIC,
  DESIGNER_ID,
  DESIGN_CONVENTION,
  parseDesign
} from './design'
import type {NoteDesign} from './design'
import './style.css'

const sats = (msat: number): string =>
  (msat / 1000).toLocaleString('en-US', {maximumFractionDigits: 3})

function App() {
  const [failure, setFailure] = createSignal('')
  const [initialized, setInitialized] = createSignal(false)
  const [exists, setExists] = createSignal(false)
  const [unlocked, setUnlocked] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [message, setMessage] = createSignal('')
  const [notes, setNotes] = createSignal<Note[]>([])
  const [selected, setSelected] = createSignal<string[]>([])
  const [password, setPassword] = createSignal('')
  const [repeat, setRepeat] = createSignal('')
  const [tab, setTab] = createSignal('wallet')
  const [input, setInput] = createSignal('')
  const [invoice, setInvoice] = createSignal('')
  const [fundingInvoice, setFundingInvoice] = createSignal('')
  const [mint, setMint] = createSignal('')
  const [amount, setAmount] = createSignal('')
  const [split, setSplit] = createSignal('')
  const [shared, setShared] = createSignal('')
  const [backup, setBackup] = createSignal('')
  const [restoreText, setRestoreText] = createSignal('')
  const [backupPassword, setBackupPassword] = createSignal('')
  const [designs, setDesigns] = createSignal<Record<string, NoteDesign>>({})
  const [designText, setDesignText] = createSignal('')
  const [designOpen, setDesignOpen] = createSignal(false)
  const [showHistory, setShowHistory] = createSignal(false)
  const [designerAvailable, setDesignerAvailable] = createSignal(false)
  let designRequest: {id: string; notes: string[]} | null = null
  let designSub: {close(): void} | undefined
  const [request, setRequest] = createSignal<WalletRequest | null>(null)
  let vault: Vault
  let wallet: Wallet
  let lastActivity = Date.now()
  let disconnect: (() => void) | undefined
  let timer: ReturnType<typeof setInterval>

  const lock = (): void => {
    if (busy()) return
    vault?.lock()
    setUnlocked(false)
    setNotes([])
    setSelected([])
    setShared('')
    setPassword('')
    setRepeat('')
    setInput('')
    setInvoice('')
    setFundingInvoice('')
    setBackupPassword('')
    setRestoreText('')
    setBackup('')
    setRequest(null)
    setDesigns({})
    setDesignText('')
    designRequest = null
  }
  const touch = (): void => {
    lastActivity = Date.now()
  }
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy()) return
    setBusy(true)
    setMessage('')
    try {
      await action()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Operation failed.')
    } finally {
      if (unlocked()) {
        try {
          setNotes(await vault.notes())
          setDesigns(await vault.designs())
        } catch {
          setMessage(
            'Could not read all notes. Keep your backup and retry when shell storage is available.'
          )
        }
      }
      setBusy(false)
      touch()
    }
  }
  const applyDesign = async (
    design: NoteDesign,
    ids: string[]
  ): Promise<void> => {
    const id = ids.length ? crypto.randomUUID() : 'default'
    await vault.saveDesign(id, design)
    for (const note of await vault.notes()) {
      if (ids.includes(note.id)) await vault.save({...note, designId: id})
    }
  }
  const openDesigner = async (): Promise<void> => {
    const intent = window.napplet?.intent
    if (!intent)
      throw new Error(
        'Your shell has no intent support. Import a design JSON instead.'
      )
    const available = await intent.available('bearer-designer')
    if (
      !available.candidates.some(
        c => c.dTag === DESIGNER_ID && c.conventions.includes(DESIGN_CONVENTION)
      )
    ) {
      throw new Error(
        'Install Paper Studio in your shell, or import its design JSON here.'
      )
    }
    designRequest = {id: crypto.randomUUID(), notes: [...selected()]}
    const designId =
      notes().find(n => n.id === selected()[0])?.designId ?? 'default'
    const result = await intent.open(
      'bearer-designer',
      {
        requestId: designRequest.id,
        design: designs()[designId] ?? DEFAULT_DESIGN
      },
      {
        handler: DESIGNER_ID,
        convention: DESIGN_CONVENTION,
        behavior: {focus: true, reuse: true}
      }
    )
    if (!result.ok || !result.handled) {
      designRequest = null
      throw new Error(result.error || 'Designer could not be opened.')
    }
  }
  const authenticate = async (): Promise<void> => {
    if (exists()) await vault.unlock(password())
    else {
      if (password() !== repeat()) throw new Error('Passwords do not match.')
      await vault.create(password())
      setExists(true)
    }
    setPassword('')
    setRepeat('')
    setUnlocked(true)
  }
  onMount(() => {
    try {
      const host = getWalletHost()
      vault = new Vault(host.storage)
      wallet = new Wallet(vault)
      window.napplet?.intent
        ?.available('bearer-designer')
        .then(result =>
          setDesignerAvailable(
            result.candidates.some(
              c =>
                c.dTag === DESIGNER_ID &&
                c.conventions.includes(DESIGN_CONVENTION)
            )
          )
        )
        .catch(() => setDesignerAvailable(false))
      designSub = host.inc?.on(DESIGN_TOPIC, event => {
        const data = event.payload as {requestId?: string; design?: unknown}
        if (
          !unlocked() ||
          busy() ||
          event.sender !== DESIGNER_ID ||
          !designRequest ||
          data?.requestId !== designRequest.id
        )
          return
        const target = designRequest.notes
        designRequest = null
        void run(async () => {
          await applyDesign(parseDesign(data.design), target)
          setMessage('Your note design is ready.')
          setDesignOpen(false)
        })
      })
      disconnect = listenWalletIntents(
        host,
        incoming => {
          if (incoming.action === 'open') {
            setTab('wallet')
            return
          }
          if (request() || busy()) {
            setMessage(
              'Another request is pending. Ask the sender to retry after review.'
            )
            return
          }
          setRequest(incoming)
        },
        setMessage
      )
      vault
        .exists()
        .then(setExists)
        .then(() => setInitialized(true))
        .catch(() =>
          setFailure(
            'Shell storage is unavailable. Reopen when the shell can persist wallet data.'
          )
        )
      timer = setInterval(() => {
        if (Date.now() - lastActivity > 300000) lock()
      }, 10000)
      document.addEventListener('pointerdown', touch)
      document.addEventListener('keydown', touch)
    } catch (error) {
      setFailure((error as Error).message)
    }
  })
  onCleanup(() => {
    disconnect?.()
    designSub?.close()
    clearInterval(timer)
    vault?.lock()
    document.removeEventListener('pointerdown', touch)
    document.removeEventListener('keydown', touch)
  })
  const toggle = (id: string): void => {
    setSelected(current =>
      current.includes(id)
        ? current.filter(value => value !== id)
        : [...current, id]
    )
  }
  const accept = (): void => {
    const value = request()!
    if (value.action === 'receive') {
      setInput(value.value)
      setTab('receive')
    }
    if (value.action === 'pay') {
      setInvoice(value.value)
      setTab('pay')
    }
    setRequest(null)
    setDesigns({})
    setDesignText('')
    designRequest = null
  }

  return (
    <div class="app">
      <header>
        <a
          class="wordmark"
          href="#"
          onClick={event => {
            event.preventDefault()
            setTab('wallet')
          }}
        >
          <span class="logo">₿</span>
          <span>
            LNURL<span class="soft">cash</span>
            <small>WALLET NAPPLET</small>
          </span>
        </a>
        <Show when={unlocked()}>
          <button class="quiet" disabled={busy()} onClick={lock}>
            Lock wallet
          </button>
        </Show>
      </header>
      <main>
        <Show
          when={!failure()}
          fallback={
            <section class="panel">
              <h1>A home for your sats.</h1>
              <p role="alert">{failure()}</p>
              <p>
                This build runs inside a NIP-5D shell. Its storage and network
                access come from that shell.
              </p>
            </section>
          }
        >
          <Show
            when={initialized()}
            fallback={<p role="status">Connecting to shell storage…</p>}
          >
            <Show
              when={unlocked()}
              fallback={
                <section class="panel onboarding">
                  <p class="eyebrow">YOUR NOTES. YOUR CONTROL.</p>
                  <h1>
                    {exists() ? 'Welcome back.' : 'A home for your sats.'}
                  </h1>
                  <p>
                    Receive, hold and spend LNURLcash notes across independent
                    mints.
                  </p>
                  <div>
                    <label>
                      Wallet password
                      <input
                        type="password"
                        autocomplete={
                          exists() ? 'current-password' : 'new-password'
                        }
                        value={password()}
                        onInput={e => setPassword(e.currentTarget.value)}
                        required
                        minlength={exists() ? 1 : 12}
                      />
                    </label>
                    <Show when={!exists()}>
                      <label>
                        Repeat password
                        <input
                          type="password"
                          autocomplete="new-password"
                          value={repeat()}
                          onInput={e => setRepeat(e.currentTarget.value)}
                          required
                          minlength="12"
                        />
                      </label>
                      <p class="hint">
                        Use 12 or more characters. Save an encrypted backup
                        after setup and whenever notes change. This napplet uses
                        a separate wallet; its recovery requires the backup and
                        password.
                      </p>
                    </Show>
                    <button
                      class="primary"
                      disabled={busy()}
                      onClick={() => void run(authenticate)}
                    >
                      {busy()
                        ? 'Opening…'
                        : exists()
                          ? 'Unlock wallet'
                          : 'Create wallet'}
                    </button>
                  </div>
                </section>
              }
            >
              <section class="balance">
                <div>
                  <p class="eyebrow">CONFIRMED NOTES</p>
                  <h1>
                    {sats(
                      notes()
                        .filter(n => n.status === 'ready')
                        .reduce((sum, n) => sum + n.amount, 0)
                    )}
                    <span> sats</span>
                  </h1>
                  <p>
                    {notes().filter(n => n.status === 'ready').length} available
                    notes · balances stay separate by mint
                  </p>
                </div>
                <span class="badge">ENCRYPTED IN SHELL STORAGE</span>
              </section>
              <nav aria-label="Wallet sections">
                <For each={['wallet', 'receive', 'pay', 'mint', 'backup']}>
                  {value => (
                    <button
                      classList={{active: tab() === value}}
                      disabled={busy()}
                      onClick={() => {
                        setTab(value)
                        setShared('')
                      }}
                    >
                      {value === 'wallet'
                        ? 'Notes'
                        : value[0].toUpperCase() + value.slice(1)}
                    </button>
                  )}
                </For>
              </nav>
              <Show when={request()}>
                <section
                  class="request"
                  role="dialog"
                  aria-label="Review wallet request"
                >
                  <p class="eyebrow">REQUEST FROM ANOTHER NAPPLET</p>
                  <h2>
                    {request()?.action === 'pay'
                      ? 'Review a payment'
                      : 'Review an incoming note'}
                  </h2>
                  <p>Sender: {request()?.sender}</p>
                  <p>Review the details, then confirm the action yourself.</p>
                  <button class="primary" disabled={busy()} onClick={accept}>
                    Review details
                  </button>
                  <button disabled={busy()} onClick={() => setRequest(null)}>
                    Dismiss
                  </button>
                </section>
              </Show>
              <Show when={tab() === 'wallet'}>
                <section class="panel">
                  <div class="section-heading">
                    <h2>Your notes</h2>
                    <div class="section-tools">
                      <button
                        disabled={busy()}
                        onClick={() => setDesignOpen(!designOpen())}
                      >
                        ✳ Design notes
                      </button>
                      <button
                        disabled={busy()}
                        onClick={() =>
                          void run(async () => {
                            setNotes(await vault.notes())
                          })
                        }
                      >
                        Reload
                      </button>
                    </div>
                  </div>
                  <Show when={designOpen()}>
                    <div class="design-drawer">
                      <h3>Make your notes your own.</h3>
                      <p>
                        {selected().length
                          ? `Design ${selected().length} selected notes.`
                          : 'Choose a default design for your collection.'}
                      </p>
                      <button
                        class="primary"
                        disabled={busy() || !designerAvailable()}
                        onClick={() => void run(openDesigner)}
                      >
                        Open Paper Studio ↗
                      </button>
                      <p class="hint">
                        Install the companion Paper Studio napplet in your
                        shell. You can also paste an exported design below.
                      </p>
                      <label>
                        Design JSON
                        <textarea
                          value={designText()}
                          onInput={e => setDesignText(e.currentTarget.value)}
                        />
                      </label>
                      <button
                        disabled={busy() || !designText()}
                        onClick={() =>
                          void run(async () => {
                            await applyDesign(
                              parseDesign(JSON.parse(designText())),
                              selected()
                            )
                            setDesignText('')
                            setDesignOpen(false)
                          })
                        }
                      >
                        Apply design
                      </button>
                    </div>
                  </Show>
                  <Show
                    when={notes().length}
                    fallback={
                      <div class="empty">
                        <Banknote
                          amount={21000}
                          issuer="your.mint"
                          serial="PREVIEW"
                          design={DEFAULT_DESIGN}
                          specimen
                        />
                        <h3>Your first note starts here.</h3>
                        <p>
                          Receive a note from someone, or mint one by paying a
                          Lightning invoice.
                        </p>
                        <button
                          class="primary"
                          onClick={() => setTab('receive')}
                        >
                          Receive a note
                        </button>
                      </div>
                    }
                  >
                    <Show when={selected().length}>
                      <div class="actions">
                        <button
                          disabled={busy() || !selected().length}
                          onClick={() =>
                            void run(async () => {
                              for (const id of selected())
                                await wallet.refresh(id)
                              setSelected([])
                            })
                          }
                        >
                          Check selected
                        </button>
                        <button
                          disabled={busy() || selected().length !== 1}
                          onClick={() =>
                            void run(async () => {
                              await wallet.transform(selected(), 'rotate')
                              setSelected([])
                            })
                          }
                        >
                          Rotate
                        </button>
                        <button
                          disabled={busy() || selected().length < 2}
                          onClick={() =>
                            void run(async () => {
                              await wallet.transform(selected(), 'combine')
                              setSelected([])
                            })
                          }
                        >
                          Combine
                        </button>
                        <button
                          disabled={busy() || selected().length !== 1}
                          onClick={() =>
                            void run(async () => {
                              setShared(await wallet.share(selected()[0]))
                              setSelected([])
                            })
                          }
                        >
                          Hand over
                        </button>
                      </div>
                      <label class="split">
                        Split amount (sats)
                        <div class="input-action">
                          <input
                            aria-label="Split amount (sats)"
                            inputmode="decimal"
                            value={split()}
                            onInput={e => setSplit(e.currentTarget.value)}
                          />
                          <button
                            disabled={busy() || !selected().length}
                            onClick={() =>
                              void run(async () => {
                                await wallet.transform(
                                  selected(),
                                  'split',
                                  Number(split()) * 1000
                                )
                                setSelected([])
                              })
                            }
                          >
                            Split selected
                          </button>
                        </div>
                      </label>
                    </Show>
                    <div class="collection-tools">
                      <p class="hint">Tap a note to select it.</p>
                      <button
                        class="quiet"
                        onClick={() => {
                          setShowHistory(!showHistory())
                          setSelected([])
                        }}
                      >
                        {showHistory() ? 'Hide history' : 'Show history'}
                      </button>
                    </div>
                    <div class="note-grid">
                      <For
                        each={notes().filter(
                          note =>
                            showHistory() ||
                            !['spent', 'shared'].includes(note.status)
                        )}
                      >
                        {note => (
                          <article
                            class="note"
                            classList={{selected: selected().includes(note.id)}}
                          >
                            <input
                              type="checkbox"
                              aria-label={`Select ${sats(note.amount)} sats ${note.status}`}
                              checked={selected().includes(note.id)}
                              disabled={busy()}
                              onChange={() => toggle(note.id)}
                            />
                            <div class="note-body">
                              <button
                                class="note-art-button"
                                aria-label={`Select note artwork ${sats(note.amount)} sats`}
                                disabled={busy()}
                                onClick={() => toggle(note.id)}
                              >
                                <Banknote
                                  amount={note.amount}
                                  issuer={serverOf(note.url)}
                                  serial={note.id}
                                  design={
                                    designs()[note.designId ?? 'default'] ??
                                    DEFAULT_DESIGN
                                  }
                                />
                              </button>
                              <div class="section-heading">
                                <strong>
                                  {sats(note.amount)}{' '}
                                  <span class="soft">sats</span>
                                </strong>
                                <span class={`status ${note.status}`}>
                                  {note.status === 'spent'
                                    ? 'not outstanding'
                                    : note.status}
                                </span>
                              </div>
                              <p>{serverOf(note.url)}</p>
                              <small>{note.reason}</small>
                              <Show
                                when={
                                  note.invoice && note.invoiceType === 'funding'
                                }
                              >
                                <button
                                  class="quiet"
                                  onClick={() => {
                                    setFundingInvoice(note.invoice!)
                                    setTab('mint')
                                  }}
                                >
                                  Show stored invoice
                                </button>
                              </Show>
                            </div>
                          </article>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={shared()}>
                    <div class="reveal">
                      <h3>Hand this note to its next holder.</h3>
                      <p>
                        Anyone with this link can spend it. It is now excluded
                        from your balance.
                      </p>
                      <QRCodeSVG
                        value={shared()}
                        level={ErrorCorrectionLevel.LOW}
                        width={180}
                        height={180}
                        backgroundColor="white"
                        backgroundAlpha={1}
                        foregroundColor="black"
                        foregroundAlpha={1}
                      />
                      <textarea
                        aria-label="Bearer note for handover"
                        readonly
                        value={shared()}
                        onFocus={e => e.currentTarget.select()}
                      />
                      <button onClick={() => setShared('')}>Hide note</button>
                    </div>
                  </Show>
                </section>
              </Show>
              <Show when={tab() === 'receive'}>
                <section class="panel">
                  <h2>Receive a note</h2>
                  <p>
                    Confirm to store the note and rotate its secret with the
                    issuing mint.
                  </p>
                  <label>
                    LNURLcash note
                    <textarea
                      placeholder="lnurlw://… or LNURL1…"
                      value={input()}
                      onInput={e => setInput(e.currentTarget.value)}
                    />
                  </label>
                  <button
                    class="primary"
                    disabled={busy() || !input().trim()}
                    onClick={() =>
                      void run(async () => {
                        await wallet.receive(input())
                        setInput('')
                        setTab('wallet')
                        setMessage('Note received and rotated.')
                      })
                    }
                  >
                    Confirm receive & rotate
                  </button>
                </section>
              </Show>
              <Show when={tab() === 'pay'}>
                <section class="panel">
                  <h2>Pay a Lightning invoice</h2>
                  <label>
                    BOLT11 invoice
                    <textarea
                      placeholder="lnbc…"
                      value={invoice()}
                      onInput={e => setInvoice(e.currentTarget.value)}
                    />
                  </label>
                  <p class="amount-review">
                    Invoice amount:{' '}
                    <strong>
                      {sats(decodeBolt11AmountMsat(invoice()) ?? 0)} sats
                    </strong>
                  </p>
                  <label>
                    Note to spend
                    <select
                      aria-label="Note to spend"
                      value={selected()[0] ?? ''}
                      onChange={e =>
                        setSelected(
                          e.currentTarget.value ? [e.currentTarget.value] : []
                        )
                      }
                    >
                      <option value="">Choose an exact-amount note</option>
                      <For each={notes().filter(n => n.status === 'ready')}>
                        {note => (
                          <option value={note.id}>
                            {sats(note.amount)} sats · {serverOf(note.url)}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                  <p class="hint">
                    The note and invoice amounts must match. Split or combine
                    notes first. After submission, use “Check selected” to
                    reconcile the note; confirm payment settlement in the
                    receiving wallet.
                  </p>
                  <button
                    class="primary"
                    disabled={
                      busy() || selected().length !== 1 || !invoice().trim()
                    }
                    onClick={() =>
                      void run(async () => {
                        await wallet.pay(selected()[0], invoice())
                        setInvoice('')
                        setSelected([])
                        setTab('wallet')
                        setMessage(
                          'Payment submitted. Settlement is not yet confirmed.'
                        )
                      })
                    }
                  >
                    Confirm payment
                  </button>
                </section>
              </Show>
              <Show when={tab() === 'mint'}>
                <section class="panel">
                  <h2>Mint a new note</h2>
                  <p>
                    Choose a mint, then pay its invoice with your Lightning
                    wallet.
                  </p>
                  <label>
                    Mint URL or Lightning address
                    <input
                      placeholder="you@mint.example"
                      value={mint()}
                      onInput={e => setMint(e.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Amount (sats)
                    <input
                      inputmode="decimal"
                      value={amount()}
                      onInput={e => setAmount(e.currentTarget.value)}
                    />
                  </label>
                  <button
                    class="primary"
                    disabled={busy() || !mint() || !amount()}
                    onClick={() =>
                      void run(async () => {
                        setFundingInvoice(
                          await wallet.mint(mint(), Number(amount()) * 1000)
                        )
                      })
                    }
                  >
                    Create funding invoice
                  </button>
                  <Show when={fundingInvoice()}>
                    <div class="reveal">
                      <QRCodeSVG
                        value={fundingInvoice()}
                        level={ErrorCorrectionLevel.LOW}
                        width={180}
                        height={180}
                        backgroundColor="white"
                        backgroundAlpha={1}
                        foregroundColor="black"
                        foregroundAlpha={1}
                      />
                      <textarea
                        aria-label="Funding invoice"
                        readonly
                        value={fundingInvoice()}
                        onFocus={e => e.currentTarget.select()}
                      />
                      <p>
                        After paying, select the pending note under Notes and
                        choose “Check selected”. Mint fees may reduce its final
                        value.
                      </p>
                    </div>
                  </Show>
                </section>
              </Show>
              <Show when={tab() === 'backup'}>
                <section class="panel">
                  <h2>Keep a recovery copy</h2>
                  <p>
                    Keep the encrypted backup and your password. Shell upgrades
                    may use a new storage scope. Pending notes are included.
                  </p>
                  <button
                    class="primary"
                    disabled={busy()}
                    onClick={() =>
                      void run(async () => {
                        setBackup(await vault.backup())
                      })
                    }
                  >
                    Prepare encrypted backup
                  </button>
                  <Show when={backup()}>
                    <label>
                      Encrypted backup — select and save as a .json file
                      <textarea
                        class="backup"
                        readonly
                        value={backup()}
                        onFocus={e => e.currentTarget.select()}
                      />
                    </label>
                  </Show>
                  <hr />
                  <h3>Import a napplet backup</h3>
                  <p>Notes merge into this wallet; existing notes are kept.</p>
                  <label>
                    Backup JSON
                    <textarea
                      value={restoreText()}
                      onInput={e => setRestoreText(e.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Backup password
                    <input
                      type="password"
                      autocomplete="off"
                      value={backupPassword()}
                      onInput={e => setBackupPassword(e.currentTarget.value)}
                    />
                  </label>
                  <button
                    disabled={busy() || !restoreText() || !backupPassword()}
                    onClick={() =>
                      void run(async () => {
                        const added = await vault.restore(
                          restoreText(),
                          backupPassword()
                        )
                        setRestoreText('')
                        setBackupPassword('')
                        setMessage(
                          `Imported ${added} notes. Check them online before using.`
                        )
                      })
                    }
                  >
                    Import encrypted notes
                  </button>
                </section>
              </Show>
            </Show>
            <Show when={busy()}>
              <p class="notice" role="status">
                Working… keep the wallet open.
              </p>
            </Show>
            <Show when={message()}>
              <p class="notice" role="status">
                {message()}
              </p>
            </Show>
          </Show>
        </Show>
      </main>
      <footer>
        LNURLcash · MIT licensed · Host-mediated storage & network
        <br />A balance is a claim on its issuing mint. Back up after every
        change.
      </footer>
    </div>
  )
}

render(() => <App />, document.getElementById('root')!)
