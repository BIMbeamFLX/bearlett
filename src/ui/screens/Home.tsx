// The balance, what is still underway, the notes handed out, and activity.
import {createSignal, For, Show} from 'solid-js'
import {Action, Copy, NoteCard, Qr} from '../kit.tsx'
import {formatSats, formatTime, shorten} from '../format.ts'
import {notify, run} from '../session.ts'
import type {Wallet} from '../../wallet/wallet.ts'
import type {Note, Operation} from '../../wallet/state.ts'

const describeOperation = (op: Operation): string => {
  if (op.kind === 'mint')
    return `Waiting for payment of ${formatSats(op.amountMsat)}`
  if (op.kind === 'melt')
    return op.state === 'in-flight'
      ? `Paying ${formatSats(op.amountMsat)}`
      : `Payment of ${formatSats(op.amountMsat)} not confirmed yet`
  return op.state === 'unknown'
    ? 'A mint call without an answer'
    : 'A mint call about to be sent'
}

export const Home = (props: {wallet: () => Wallet}) => {
  const [shown, setShown] = createSignal<string | null>(null)
  const w = () => props.wallet()
  const mints = () => Object.values(w().snapshot.mints)
  const operations = () => Object.values(w().snapshot.operations)
  const outgoing = () => w().notes({role: 'outgoing', status: 'live'})
  const incoming = () => w().notes({role: 'incoming', status: 'live'})
  const locked = () => w().notes({role: 'locked', status: 'live'})
  const unlocksAt = (note: Note): number =>
    note.spend.kind === 'timelock' ? note.spend.locktime * 1000 : 0

  return (
    <>
      <section class="panel">
        <h2>Balance</h2>
        <Show
          when={mints().length}
          fallback={<p class="quiet">Add a mint under Settings to start.</p>}
        >
          <ul class="list">
            <For each={mints()}>
              {mint => (
                <li>
                  <span>{mint.name ?? mint.domain}</span>
                  <span class="amount">
                    {formatSats(w().balanceMsat(mint.domain))}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <Show when={operations().length || incoming().length}>
        <section class="panel">
          <h2>Underway</h2>
          <ul class="list">
            <For each={operations()}>
              {op => (
                <li>
                  <div>
                    <div>{describeOperation(op)}</div>
                    <Show when={op.kind === 'mint'}>
                      <button
                        class="link"
                        onClick={() =>
                          setShown(shown() === op.id ? null : op.id)
                        }
                      >
                        {shown() === op.id ? 'Hide invoice' : 'Show invoice'}
                      </button>
                      <Show
                        when={shown() === op.id && op.kind === 'mint' && op}
                      >
                        {mintOp => (
                          <div>
                            <Qr value={mintOp().pr.toUpperCase()} />
                            <div class="row">
                              <Copy value={mintOp().pr} label="Copy invoice" />
                              <button
                                class="secondary"
                                onClick={() =>
                                  run('Removing', () => w().dropMint(mintOp()))
                                }
                              >
                                Forget it
                              </button>
                            </div>
                          </div>
                        )}
                      </Show>
                    </Show>
                  </div>
                  <span class="quiet">{formatTime(op.createdAt)}</span>
                </li>
              )}
            </For>
            <For each={incoming()}>
              {note => (
                <li>
                  <span>Received, not yet rotated</span>
                  <span class="amount">{formatSats(note.amountMsat)}</span>
                </li>
              )}
            </For>
          </ul>
          <Action
            kind="secondary"
            onClick={() =>
              run('Checking with the mints', async () => {
                await w().settle()
                notify('Checked.')
              })
            }
          >
            Check now
          </Action>
        </section>
      </Show>

      <Show when={locked().length}>
        <section class="panel">
          <h2>Locked</h2>
          <ul class="list">
            <For each={locked()}>
              {note => (
                <li>
                  <div>
                    <div>Unlocks {formatTime(unlocksAt(note))}</div>
                    <Show when={unlocksAt(note) <= Date.now()}>
                      <button
                        class="link"
                        onClick={() =>
                          run('Unlocking', () => w().unlock(note.q))
                        }
                      >
                        Unlock now
                      </button>
                    </Show>
                  </div>
                  <span class="amount">{formatSats(note.amountMsat)}</span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      <Show when={outgoing().length}>
        <section class="panel">
          <h2>Handed out</h2>
          <p class="quiet">
            Notes not yet rotated by whoever holds them. You can take them back.
          </p>
          <ul class="list">
            <For each={outgoing()}>
              {note => (
                <li>
                  <div>
                    <div>{note.memo ?? shorten(note.q, 6)}</div>
                    <div class="row">
                      <button
                        class="link"
                        onClick={() =>
                          setShown(shown() === note.q ? null : note.q)
                        }
                      >
                        {shown() === note.q ? 'Hide' : 'Show link'}
                      </button>
                      <button
                        class="link"
                        onClick={() =>
                          run('Taking it back', () => w().reclaim(note.q))
                        }
                      >
                        Take back
                      </button>
                    </div>
                    <Show when={shown() === note.q}>
                      <NoteCard
                        value={w().noteLink(note.q)}
                        design={w().snapshot.settings.design}
                      />
                      <Copy value={w().noteLink(note.q)} label="Copy link" />
                    </Show>
                  </div>
                  <span class="amount">{formatSats(note.amountMsat)}</span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      <section class="panel">
        <h2>Activity</h2>
        <Show
          when={w().snapshot.activity.length}
          fallback={<p class="quiet">Nothing yet.</p>}
        >
          <ul class="list">
            <For each={w().snapshot.activity.slice(0, 30)}>
              {entry => (
                <li>
                  <div>
                    <div>{entry.text}</div>
                    <div class="quiet">
                      {formatTime(entry.at)}
                      {entry.mint ? ` · ${entry.mint}` : ''}
                    </div>
                  </div>
                  <Show when={entry.amountMsat}>
                    <span class="amount">{formatSats(entry.amountMsat!)}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </>
  )
}
