// Small building blocks every screen uses.
import {createSignal, For, onCleanup, onMount, Show, type JSX} from 'solid-js'
import encodeQR from 'qr'
import decodeQR from 'qr/decode.js'
import {busy, notify} from './session.ts'
import {formatSats} from './format.ts'
import type {Mint} from '../wallet/state.ts'

/** A QR code of `value`, in the parchment frame. */
export const Qr = (props: {value: string}) => (
  // the SVG comes from the encoder, never from user markup
  <div
    class="qr"
    innerHTML={encodeQR(props.value, 'svg', {ecc: 'medium', border: 1})}
  />
)

export const Copy = (props: {value: string; label?: string}) => (
  <button
    class="secondary"
    onClick={async () => {
      try {
        await navigator.clipboard.writeText(props.value)
        notify('Copied.')
      } catch {
        notify('Copying is not allowed here. Select the text instead.', true)
      }
    }}
  >
    {props.label ?? 'Copy'}
  </button>
)

export const Field = (props: {
  label: string
  children: JSX.Element
  hint?: string
}) => (
  // the label wraps its control, so the control is named by it
  <label class="field">
    <span class="caption">{props.label}</span>
    {props.children}
    <Show when={props.hint}>
      <span class="quiet hint">{props.hint}</span>
    </Show>
  </label>
)

/** A primary action that shows what is running while it runs. */
export const Action = (props: {
  onClick: () => void
  children: JSX.Element
  disabled?: boolean
  kind?: 'primary' | 'secondary'
}) => (
  <button
    class={props.kind ?? 'primary'}
    disabled={props.disabled || busy() !== null}
    onClick={() => props.onClick()}
  >
    {props.children}
  </button>
)

export const Busy = () => (
  <Show when={busy()}>
    <p class="quiet">{busy()}…</p>
  </Show>
)

/** Picks a mint; with only one there is nothing to pick. */
export const MintSelect = (props: {
  mints: Mint[]
  value: string
  onChange: (domain: string) => void
  balanceOf: (domain: string) => number
}) => (
  <Show
    when={props.mints.length > 1}
    fallback={
      <p class="quiet">
        Mint: {props.mints[0]?.name ?? props.mints[0]?.domain ?? 'none yet'}
      </p>
    }
  >
    <Field label="Mint">
      <select
        value={props.value}
        onChange={e => props.onChange(e.currentTarget.value)}
      >
        <For each={props.mints}>
          {mint => (
            <option value={mint.domain}>
              {mint.name ?? mint.domain} ·{' '}
              {formatSats(props.balanceOf(mint.domain))}
            </option>
          )}
        </For>
      </select>
    </Field>
  </Show>
)

/** Scans QR codes from the camera until one decodes. */
export const Scanner = (props: {
  onScan: (text: string) => void
  onClose: () => void
}) => {
  let video!: HTMLVideoElement
  let stream: MediaStream | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const [error, setError] = createSignal<string | null>(null)
  onMount(async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: 'environment'}
      })
      video.srcObject = stream
      await video.play()
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d', {willReadFrequently: true})!
      timer = setInterval(() => {
        if (!video.videoWidth) return
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        context.drawImage(video, 0, 0)
        const image = context.getImageData(0, 0, canvas.width, canvas.height)
        try {
          const text = decodeQR({
            width: image.width,
            height: image.height,
            data: image.data
          })
          if (text) props.onScan(text)
        } catch {
          // no code in this frame
        }
      }, 250)
    } catch {
      setError('No camera, or no permission to use it.')
    }
  })
  onCleanup(() => {
    clearInterval(timer)
    stream?.getTracks().forEach(track => track.stop())
  })
  return (
    <div>
      <Show
        when={error()}
        fallback={<video class="scanner" ref={video} muted playsinline />}
      >
        <p class="warn">{error()}</p>
      </Show>
      <button class="secondary" onClick={() => props.onClose()}>
        Close camera
      </button>
    </div>
  )
}
