import {Show} from 'solid-js'
import type {JSX} from 'solid-js'
import './session-bar.css'

export type SessionBarProps = {
  surface: string
  figure: string
  detail: string
  waiting?: string
  locked?: boolean
  onHome?: () => void
  onWaiting?: () => void
  onLock?: () => void
  lockLabel?: string
  embedded?: boolean
  children?: JSX.Element
}

/**
 * One strip for every Bearlett surface.
 *
 * Figure, lock, and anything waiting. The same markup at 300px and at full
 * width. Children are the place links when a host already has them.
 */
export default function SessionBar(props: SessionBarProps) {
  return (
    <header
      class="session-bar"
      classList={{'session-bar--embedded': props.embedded}}
      aria-label="Bearlett"
    >
      <button
        type="button"
        class="session-bar__mark"
        onClick={() => props.onHome?.()}
      >
        Bearlett
        <small>{props.surface}</small>
      </button>
      <p class="session-bar__figure">
        <strong>{props.locked ? 'Locked' : props.figure}</strong>
        <span class="session-bar__detail">
          {props.locked ? 'Unlock to continue' : props.detail}
        </span>
      </p>
      <Show when={props.waiting}>
        <button
          type="button"
          class="session-bar__wait"
          onClick={() => props.onWaiting?.()}
        >
          {props.waiting}
        </button>
      </Show>
      <Show when={props.onLock}>
        <button type="button" class="session-bar__lock" onClick={props.onLock}>
          {props.lockLabel ?? 'Lock'}
        </button>
      </Show>
      {props.children}
    </header>
  )
}
