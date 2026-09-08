import {createSignal, onCleanup, onMount, For, Show} from 'solid-js'
import {render} from 'solid-js/web'
import Banknote from './Banknote'
import {
  DEFAULT_DESIGN,
  DESIGN_TOPIC,
  DESIGN_CONVENTION,
  parseDesign,
  readArtwork
} from './design'
import type {NoteDesign} from './design'
import './style.css'
import './designer.css'

function Designer() {
  const [design, setDesign] = createSignal<NoteDesign>({...DEFAULT_DESIGN})
  const [amount, setAmount] = createSignal('21')
  const [message, setMessage] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [requestId, setRequestId] = createSignal('')
  const [exported, setExported] = createSignal('')
  let subscription: {close(): void} | undefined
  let receivedRequest = false
  onMount(() => {
    const host = window.napplet
    subscription = host?.inc?.on(DESIGN_CONVENTION, event => {
      if (event.sender !== 'lnurlcash-wallet') return
      try {
        const data = event.payload as {requestId?: unknown; design?: unknown}
        if (
          !data ||
          typeof data.requestId !== 'string' ||
          !/^[a-zA-Z0-9-]{1,80}$/.test(data.requestId)
        )
          return
        receivedRequest = true
        setDesign(parseDesign(data.design))
        setRequestId(data.requestId)
        setMessage(
          'Connected to your wallet. Choose “Use in wallet” when ready.'
        )
      } catch {
        setMessage('The requested design could not be opened.')
      }
    })
    host?.storage
      ?.getItem('bearer-design:v1')
      .then(raw => {
        if (raw && !receivedRequest) setDesign(parseDesign(JSON.parse(raw)))
      })
      .catch(() =>
        setMessage('Saved draft unavailable. You can still design and export.')
      )
  })
  onCleanup(() => subscription?.close())
  const update = (change: Partial<NoteDesign>): void => {
    setDesign({...design(), ...change})
    setExported('')
  }
  const upload = async (file: File): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      update({image: await readArtwork(file)})
    } catch (error) {
      setMessage((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const save = async (send: boolean): Promise<void> => {
    setBusy(true)
    try {
      const clean = parseDesign(design())
      if (window.napplet?.storage)
        await window.napplet.storage.setItem(
          'bearer-design:v1',
          JSON.stringify(clean)
        )
      if (send) {
        if (!requestId() || !window.napplet?.inc)
          throw new Error('Open the designer from your wallet first.')
        window.napplet.inc.emit(DESIGN_TOPIC, {
          requestId: requestId(),
          design: clean
        })
        setMessage(
          'Design sent to your wallet. Bearer secrets never enter this designer.'
        )
      } else {
        setExported(JSON.stringify(clean, null, 2))
        setMessage('Design ready to save as JSON.')
      }
    } catch (error) {
      setMessage((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="app studio">
      <header>
        <div class="wordmark">
          <span class="logo">✳</span>
          <span>
            Paper<span class="soft">studio</span>
            <small>LNURLCASH NOTE DESIGNER</small>
          </span>
        </div>
        <span class="studio-label">MAKE YOUR SATS YOURS</span>
      </header>
      <main>
        <p class="eyebrow">A SMALL NOTE. A PERSONAL TOUCH.</p>
        <h1>Make something worth holding.</h1>
        <p class="intro">
          Turn an image, a colour and a few words into your own bearer note.
        </p>
        <div class="studio-grid">
          <section class="preview-stage">
            <div class="preview-caption">
              <span>LIVE PREVIEW</span>
              <span>01 / FRONT</span>
            </div>
            <Banknote
              amount={
                Math.max(0, Math.min(2100000000, Number(amount()) || 0)) * 1000
              }
              issuer="your.mint"
              serial="DESIGN01"
              design={design()}
              specimen
            />
            <div class="preview-foot">
              The wallet supplies the real amount and issuer.
              <br />
              This design contains no bearer secret or spendable QR.
            </div>
          </section>
          <section class="panel studio-controls">
            <h2>The details</h2>
            <label>
              Note heading
              <input
                maxlength="48"
                value={design().title}
                onInput={e => update({title: e.currentTarget.value})}
              />
            </label>
            <label>
              A line of your own
              <input
                maxlength="100"
                value={design().subtitle}
                onInput={e => update({subtitle: e.currentTarget.value})}
              />
            </label>
            <label>
              Preview denomination (sats)
              <input
                type="number"
                min="0"
                max="2100000000"
                value={amount()}
                onInput={e => setAmount(e.currentTarget.value)}
              />
            </label>
            <div class="field-label">Choose a palette</div>
            <div class="palettes">
              <For
                each={[
                  {name: 'Linen', ink: '#174c3a', paper: '#f3ecd3'},
                  {name: 'Copper', ink: '#743e29', paper: '#f4dfc4'},
                  {name: 'Midnight', ink: '#263b66', paper: '#e4eaf2'},
                  {name: 'Rose', ink: '#763d59', paper: '#f5e3e8'}
                ]}
              >
                {palette => (
                  <button
                    title={palette.name}
                    aria-label={`${palette.name} palette`}
                    classList={{chosen: design().ink === palette.ink}}
                    style={{background: palette.paper, color: palette.ink}}
                    onClick={() =>
                      update({ink: palette.ink, paper: palette.paper})
                    }
                  >
                    ₿<small>{palette.name}</small>
                  </button>
                )}
              </For>
            </div>
            <div class="color-fields">
              <label>
                Ink
                <input
                  type="color"
                  value={design().ink}
                  onInput={e => update({ink: e.currentTarget.value})}
                />
              </label>
              <label>
                Paper
                <input
                  type="color"
                  value={design().paper}
                  onInput={e => update({paper: e.currentTarget.value})}
                />
              </label>
            </div>
            <label class="upload-zone">
              {design().image ? 'Replace artwork' : '+ Add your own artwork'}
              <input
                aria-label="Upload artwork"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={busy()}
                onChange={e => {
                  const file = e.currentTarget.files?.[0]
                  if (file) void upload(file)
                }}
              />
              <small>PNG, JPG or WebP · resized locally</small>
            </label>
            <Show when={design().image}>
              <button class="quiet" onClick={() => update({image: undefined})}>
                Remove image
              </button>
            </Show>
            <div class="studio-buttons">
              <button
                class="primary"
                disabled={busy() || !requestId()}
                onClick={() => void save(true)}
              >
                Use in wallet ↗
              </button>
              <button disabled={busy()} onClick={() => void save(false)}>
                Export design
              </button>
            </div>
            <Show when={!requestId()}>
              <p class="hint">
                Open Paper Studio from the wallet to apply your design directly,
                or export it and import the JSON there.
              </p>
            </Show>
          </section>
        </div>
        <Show when={message()}>
          <p class="notice" role="status">
            {message()}
          </p>
        </Show>
        <Show when={exported()}>
          <label>
            Design JSON
            <textarea
              class="backup"
              readonly
              value={exported()}
              onFocus={e => e.currentTarget.select()}
            />
          </label>
        </Show>
      </main>
      <footer>
        Paper Studio · A separate LNURLcash napplet · MIT licensed
      </footer>
    </div>
  )
}

render(() => <Designer />, document.getElementById('root')!)
