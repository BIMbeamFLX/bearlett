// Paying a TollGate hotspot for network access (docs/TOLLGATE-LNURLCASH-TIP.md).
// The web app talks to it directly; that works where this page is served
// from a local address on the TollGate's network. Elsewhere a browser
// blocks plain http to it, and a note link goes into the TollGate's page.
import {createMemo, createSignal, For, Match, Show, Switch} from 'solid-js'
import {Action, Field} from '../kit.tsx'
import {formatAllotment, formatSats} from '../format.ts'
import {notify, run} from '../session.ts'
import {TransportError} from '../../lnurl/errors.ts'
import {
  choicesFor,
  deliverPayment,
  OUTCOME_UNKNOWN,
  planPayment,
  preparePayment,
  type Choice,
  type Payment
} from '../../tollgate/customer.ts'
import {
  parseAdvertisement,
  TollGateNotice,
  tollGateUrl,
  type Advertisement,
  type Session,
  type TollGateHttp
} from '../../tollgate/tollgate.ts'
import type {Wallet} from '../../wallet/wallet.ts'

export const TollGate = (props: {wallet: () => Wallet; http: TollGateHttp}) => {
  const w = () => props.wallet()
  const [address, setAddress] = createSignal('')
  const [url, setUrl] = createSignal<string | null>(null)
  const [ad, setAd] = createSignal<Advertisement | null>(null)
  const [picked, setPicked] = createSignal(0)
  const [steps, setSteps] = createSignal('')
  const [session, setSession] = createSignal<Session | null>(null)
  const [pending, setPending] = createSignal<Payment | null>(null)
  const [unreachable, setUnreachable] = createSignal(false)
  /** whether the chosen mint answers from here: it decides how to pay */
  const [online, setOnline] = createSignal<boolean | null>(null)

  const choices = createMemo(() => {
    const advertisement = ad()
    return advertisement ? choicesFor(advertisement, w()) : []
  })
  const choice = (): Choice | undefined => choices()[picked()]
  const wanted = () =>
    Math.max(
      Number.parseInt(steps(), 10) || 0,
      choice()?.offer.minSteps ?? 0,
      1
    )
  const plan = createMemo(() => {
    const target = choice()
    const reach = online()
    if (!target || reach === null) return undefined
    return planPayment(w(), target, wanted(), reach)
  })
  const step = () => {
    const advertisement = ad()
    return advertisement
      ? formatAllotment(advertisement.stepSize, advertisement.metric)
      : ''
  }

  const lookUp = () =>
    run('Asking the TollGate', async () => {
      const root = tollGateUrl(address())
      if (!root)
        throw new Error(
          'Enter the TollGate’s address on this network, e.g. 192.168.1.1.'
        )
      setUnreachable(false)
      setSession(null)
      setPending(null)
      try {
        setAd(parseAdvertisement(await props.http.get(root)))
      } catch (err) {
        if (err instanceof TransportError) setUnreachable(true)
        throw err
      }
      setUrl(root)
      setPicked(0)
      await checkReach()
    })

  const checkReach = async () => {
    const target = choice()
    setOnline(null)
    if (target) setOnline(await w().reachable(target.domain))
  }

  const settled = (answer: Session) => {
    setSession(answer)
    setPending(null)
    notify(
      `Online: ${formatAllotment(answer.allotment, answer.metric)} in all.`
    )
  }

  /** A payment whose answer never came stays, to be delivered again. */
  const keepIfOpen = (err: unknown, payment: Payment | null) => {
    const open =
      err instanceof TransportError ||
      (err instanceof TollGateNotice && err.code === OUTCOME_UNKNOWN)
    setPending(open ? payment : null)
  }

  const pay = () =>
    run('Paying the TollGate', async () => {
      const advertisement = ad()
      const target = choice()
      const root = url()
      if (!advertisement || !target || !root) return
      const reach = await w().reachable(target.domain)
      if (reach !== online()) {
        setOnline(reach)
        throw new Error(
          'Your mint just came into or went out of reach. Check what paying does now, then pay again.'
        )
      }
      const payment = await preparePayment(w(), target, wanted(), reach)
      try {
        settled(
          await deliverPayment(
            w(),
            props.http,
            root,
            advertisement.pubkey,
            payment
          )
        )
      } catch (err) {
        keepIfOpen(err, payment)
        throw err
      }
    })

  const again = () =>
    run('Asking the TollGate again', async () => {
      const payment = pending()
      const advertisement = ad()
      const root = url()
      if (!payment || !advertisement || !root) return
      try {
        settled(
          await deliverPayment(
            w(),
            props.http,
            root,
            advertisement.pubkey,
            payment
          )
        )
      } catch (err) {
        keepIfOpen(err, payment)
        throw err
      }
    })

  return (
    <>
      <h2>Pay a TollGate</h2>
      <p class="quiet">
        Buys network access at a TollGate hotspot with notes of your mints.
        Bearlett asks the TollGate directly, which works while this page is
        served on the TollGate’s own network.
      </p>
      <Field label="TollGate address">
        <input
          value={address()}
          placeholder="192.168.1.1"
          onInput={e => setAddress(e.currentTarget.value)}
          spellcheck={false}
        />
      </Field>
      <Action onClick={lookUp}>Look up</Action>
      <Show when={unreachable()}>
        <p class="quiet">
          From here the browser cannot reach it. Make a note under Note and
          paste its link into the TollGate’s own page instead.
        </p>
      </Show>
      <Show when={ad()}>
        {advertisement => (
          <Show
            when={choices().length}
            fallback={
              <p class="quiet">
                This TollGate takes notes only from mints you do not hold:{' '}
                {advertisement()
                  .offers.map(offer => new URL(offer.mint).host)
                  .join(', ') || 'none'}
                .
              </p>
            }
          >
            <Show when={choices().length > 1}>
              <Field label="Pay with">
                <select
                  value={picked()}
                  onChange={e => {
                    setPicked(Number(e.currentTarget.value))
                    void run('Checking the mint', checkReach)
                  }}
                >
                  <For each={choices()}>
                    {(option, i) => (
                      <option value={i()}>
                        {option.domain}: {formatSats(option.offer.priceMsat)}{' '}
                        per {step()}
                      </option>
                    )}
                  </For>
                </select>
              </Field>
            </Show>
            <Show when={choice()}>
              {target => (
                <>
                  <p>
                    {formatSats(target().offer.priceMsat)} per {step()}
                    <Show when={target().offer.minSteps > 1}>
                      <span class="quiet">
                        {' '}
                        (at least {target().offer.minSteps} steps)
                      </span>
                    </Show>
                  </p>
                  <Field label="Steps">
                    <input
                      inputmode="numeric"
                      value={steps()}
                      placeholder={String(Math.max(target().offer.minSteps, 1))}
                      onInput={e => setSteps(e.currentTarget.value)}
                    />
                  </Field>
                  <Show when={plan() !== undefined}>
                    <Show
                      when={plan()}
                      fallback={
                        <p class="quiet">
                          Your mint is out of reach from here, and no single
                          note of yours covers that.
                        </p>
                      }
                    >
                      {p => (
                        <>
                          <p>
                            {formatAllotment(
                              p().steps * advertisement().stepSize,
                              advertisement().metric
                            )}{' '}
                            for{' '}
                            <span class="amount">
                              {formatSats(p().amountMsat)}
                            </span>
                          </p>
                          <Switch>
                            <Match when={p().via === 'key'}>
                              <p class="good">
                                Onto the TollGate’s own key: nothing anyone
                                could take on the air.
                              </p>
                            </Match>
                            <Match when={p().via === 'note'}>
                              <p class="quiet">
                                As a note link of the exact price. On open Wi-Fi
                                anyone nearby can race it; a refused one is
                                taken back at once.
                              </p>
                            </Match>
                            <Match when={p().via === 'whole note'}>
                              <p class="quiet">
                                Your mint is out of reach from here, so Bearlett
                                hands over your smallest note that covers it,
                                and the TollGate grants all of it. On open Wi-Fi
                                anyone nearby can race a note.
                              </p>
                            </Match>
                          </Switch>
                          <Action onClick={pay}>Pay</Action>
                        </>
                      )}
                    </Show>
                  </Show>
                </>
              )}
            </Show>
          </Show>
        )}
      </Show>
      <Show when={pending()}>
        <p class="quiet">
          The TollGate has not confirmed this payment yet. Asking again is safe:
          it is the same payment.
        </p>
        <Action onClick={again} kind="secondary">
          Ask again
        </Action>
      </Show>
      <Show when={session()}>
        {answer => (
          <p class="good">
            Online: {formatAllotment(answer().allotment, answer().metric)} in
            all.
          </p>
        )}
      </Show>
    </>
  )
}
