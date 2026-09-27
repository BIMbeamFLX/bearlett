// Mints, recovery from the seed, and the wallet's own settings.
import {createSignal, For, Show} from 'solid-js'
import {Action, Busy, Field} from '../kit.tsx'
import {formatSats, shorten} from '../format.ts'
import {notify, run} from '../session.ts'
import {Wallet} from '../../wallet/wallet.ts'
import type {Platform} from '../../platform/platform.ts'

export const Settings = (props: {
  wallet: () => Wallet
  platform: Platform
  onLock: () => void
}) => {
  const w = () => props.wallet()
  const mints = () => Object.values(w().snapshot.mints)
  const [mintInput, setMintInput] = createSignal('')
  const [progress, setProgress] = createSignal('')
  const [gap, setGap] = createSignal(String(w().snapshot.settings.gapLimit))
  const [passphrase, setPassphrase] = createSignal('')
  const [words, setWords] = createSignal<string | null>(null)

  const recover = (domain: string) =>
    run(`Scanning ${domain}`, async () => {
      const found = await w().recover(domain, (purpose, index) =>
        setProgress(`${domain}: purpose ${purpose}, key ${index}`)
      )
      setProgress('')
      notify(
        found
          ? `Found ${found} notes at ${domain}.`
          : `Nothing new at ${domain}.`
      )
    })

  return (
    <>
      <section class="panel">
        <h2>Mints</h2>
        <ul class="list">
          <For each={mints()}>
            {mint => (
              <li>
                <div>
                  <div>{mint.name ?? mint.domain}</div>
                  <div class="quiet">
                    {mint.fee
                      ? `fee ${mint.fee.baseMsat / 1000} sat + ${mint.fee.ppm / 10_000}%`
                      : 'no fee advertised'}
                    {mint.mintPubkey
                      ? ` · key ${shorten(mint.mintPubkey, 5)}`
                      : ''}
                    {mint.payUrl ? '' : ' · receive only'}
                  </div>
                  <div class="row">
                    <button class="link" onClick={() => recover(mint.domain)}>
                      Scan for my notes
                    </button>
                    <button
                      class="link"
                      onClick={() =>
                        run(
                          `Looking for old notes at ${mint.domain}`,
                          async () => {
                            const found = await w().importLegacy(mint.domain)
                            notify(
                              found
                                ? `Moved ${found} notes from the old Bearlett.`
                                : 'No notes from the old Bearlett here.'
                            )
                          }
                        )
                      }
                    >
                      Import from old Bearlett
                    </button>
                    <button
                      class="link"
                      onClick={() =>
                        run('Removing', () => w().removeMint(mint.domain))
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <span class="amount">
                  {formatSats(w().balanceMsat(mint.domain))}
                </span>
              </li>
            )}
          </For>
        </ul>
        <Show when={progress()}>
          <p class="quiet">{progress()}</p>
        </Show>
        <Field
          label="Add a mint"
          hint="Its domain, its Lightning Address, or its LNURL."
        >
          <input
            value={mintInput()}
            onInput={e => setMintInput(e.currentTarget.value)}
            spellcheck={false}
          />
        </Field>
        <Action
          disabled={!mintInput().trim()}
          onClick={() =>
            run('Adding the mint', async () => {
              const mint = await w().addMint(mintInput())
              setMintInput('')
              notify(`Added ${mint.name ?? mint.domain}.`)
            })
          }
        >
          Add mint
        </Action>
        <Busy />
      </section>

      <section class="panel">
        <h2>Wallet</h2>
        <Field
          label="Recovery gap limit"
          hint="How many unused keys in a row a scan checks before it stops."
        >
          <input
            inputmode="numeric"
            value={gap()}
            onInput={e => setGap(e.currentTarget.value)}
            onChange={() => run('Saving', () => w().setGapLimit(Number(gap())))}
          />
        </Field>
        <div class="field">
          <label>
            <input
              type="checkbox"
              style={{width: 'auto', 'margin-right': '0.5em'}}
              checked={w().snapshot.settings.offline}
              onChange={e =>
                run('Saving', () => w().setOffline(e.currentTarget.checked))
              }
            />
            Offline: send nothing to any mint
          </label>
        </div>
        <Show
          when={words()}
          fallback={
            <>
              <Field label="Show my 12 words" hint="Needs your passphrase.">
                <input
                  type="password"
                  value={passphrase()}
                  onInput={e => setPassphrase(e.currentTarget.value)}
                />
              </Field>
              <Action
                kind="secondary"
                onClick={() =>
                  run('Opening', async () => {
                    setWords(
                      await Wallet.revealWords(
                        props.platform.store,
                        passphrase()
                      )
                    )
                    setPassphrase('')
                  })
                }
              >
                Show words
              </Action>
            </>
          }
        >
          <ol class="words">
            <For each={words()!.split(' ')}>{word => <li>{word}</li>}</For>
          </ol>
          <button class="secondary" onClick={() => setWords(null)}>
            Hide
          </button>
        </Show>
        <div class="row" style={{'margin-top': '1rem'}}>
          <button class="secondary" onClick={() => props.onLock()}>
            Lock
          </button>
        </div>
      </section>

      <section class="panel">
        <h2>About</h2>
        <p class="quiet">
          Bearlett follows LUD-25 (LNURLcash) as drafted at lnurl/luds, branch
          lnurlcash, 50d740a: notes are taproot output keys, spent by ck1, cw1
          or a bearer preimage, and certified offline with cs1. MIT licensed.
        </p>
      </section>
    </>
  )
}
