// Bearlett as a TollGate customer. Behind a captive portal the mint is out
// of reach, so the usual payment is a whole note handed over offline (the
// TollGate grants all it is worth, as TIP-02 does for a Cashu token). With
// a route to the mint, Bearlett pays the exact amount instead: onto the
// TollGate's own key where it publishes one, else as a fresh bearer note.
import {encodeCp1} from '../spec/encoding.ts'
import {hexToBytes} from '../spec/bytes.ts'
import {TransportError} from '../lnurl/errors.ts'
import type {Hex, Note} from '../wallet/state.ts'
import type {Wallet} from '../wallet/wallet.ts'
import {
  endpointOf,
  keyPaymentBody,
  parsePaymentAnswer,
  priceMsat,
  stepsFor,
  TollGateNotice,
  type Advertisement,
  type Offer,
  type Session,
  type TollGateHttp
} from './tollgate.ts'

/** An offer at a mint this wallet holds notes at. */
export type Choice = {offer: Offer; domain: string; balanceMsat: number}

/** The offers this wallet can pay, cheapest step first. */
export const choicesFor = (ad: Advertisement, wallet: Wallet): Choice[] => {
  const byEndpoint = new Map(
    Object.values(wallet.snapshot.mints).map(mint => [
      endpointOf(mint.withdrawLink),
      mint.domain
    ])
  )
  return ad.offers
    .flatMap(offer => {
      const domain = byEndpoint.get(offer.mint)
      return domain
        ? [{offer, domain, balanceMsat: wallet.balanceMsat(domain)}]
        : []
    })
    .sort((a, b) => a.offer.priceMsat - b.offer.priceMsat)
}

export type Via = 'key' | 'note' | 'whole note'

/** A payment made at the mint (or handed over), not yet answered. */
export type Payment = {
  via: Via
  body: string
  amountMsat: number
  /** the note paid: the TollGate's key, or the note handed over */
  q: Hex
}

/** The smallest own note that covers `amountMsat`, for paying offline. */
export const wholeNoteFor = (
  wallet: Wallet,
  domain: string,
  amountMsat: number
): Note | null =>
  wallet
    .notes({mint: domain, role: 'own', status: 'live'})
    .filter(note => note.amountMsat >= amountMsat)
    .sort((a, b) => a.amountMsat - b.amountMsat)[0] ?? null

/** What paying will do, to show before it is done. */
export type Plan = {via: Via; amountMsat: number; steps: number; note?: Note}

/**
 * Paying for `steps` (at least the offer's minimum). Online it pays the
 * exact price: by key if the TollGate publishes its branch there, else by a
 * fresh bearer note. Offline it hands over the smallest whole note that
 * covers the price, and gets all of it in steps. Null: nothing covers it.
 */
export const planPayment = (
  wallet: Wallet,
  choice: Choice,
  steps: number,
  online: boolean
): Plan | null => {
  const {offer, domain} = choice
  const amountMsat = priceMsat(offer, steps)
  if (online)
    return {
      via: offer.cpub ? 'key' : 'note',
      amountMsat,
      steps: stepsFor(offer, amountMsat)
    }
  const note = wholeNoteFor(wallet, domain, amountMsat)
  if (!note) return null
  return {
    via: 'whole note',
    amountMsat: note.amountMsat,
    steps: stepsFor(offer, note.amountMsat),
    note
  }
}

/** Makes the payment planPayment describes: at the mint, or by handing a note over. */
export const preparePayment = async (
  wallet: Wallet,
  choice: Choice,
  steps: number,
  online: boolean
): Promise<Payment> => {
  const {offer, domain} = choice
  const plan = planPayment(wallet, choice, steps, online)
  if (!plan)
    throw new Error(
      'No single note covers that, and the mint is out of reach to split one.'
    )
  if (plan.note) {
    await wallet.handOut(plan.note.q, 'TollGate')
    return {
      via: plan.via,
      body: wallet.noteLink(plan.note.q),
      amountMsat: plan.amountMsat,
      q: plan.note.q
    }
  }
  if (plan.via === 'key' && offer.cpub) {
    const q = await wallet.transferToBranch(
      domain,
      plan.amountMsat,
      offer.cpub,
      'Paid a TollGate'
    )
    return {
      via: 'key',
      body: keyPaymentBody(encodeCp1(hexToBytes(q)), offer),
      amountMsat: plan.amountMsat,
      q
    }
  }
  const note = await wallet.send(domain, plan.amountMsat, 'TollGate')
  return {
    via: 'note',
    body: wallet.noteLink(note.q),
    amountMsat: plan.amountMsat,
    q: note.q
  }
}

/** A TollGate's answer while the mint has not confirmed its rotation yet. */
export const OUTCOME_UNKNOWN = 'payment-outcome-unknown'

const unsettled = (err: unknown): boolean =>
  err instanceof TransportError ||
  (err instanceof TollGateNotice && err.code === OUTCOME_UNKNOWN)

export type Retry = {attempts: number; delayMs: number}

/**
 * Hands a payment to the TollGate and settles the note behind it. A lost
 * answer, or a TollGate still waiting for the mint, is asked again with the
 * same body: the TIP makes that a replay, answered with the same session.
 * A note the TollGate refused, or answered for in a way nobody can trust,
 * is taken back at once where the mint is reachable: it crossed the air in
 * the clear. One whose fate is still open stays handed out, so the same
 * payment can be delivered again later, or the note taken back.
 */
export const deliverPayment = async (
  wallet: Wallet,
  http: TollGateHttp,
  url: string,
  pubkey: string,
  payment: Payment,
  retry: Retry = {attempts: 3, delayMs: 2000}
): Promise<Session> => {
  for (let attempt = 1; ; attempt++) {
    try {
      const session = parsePaymentAnswer(
        await http.post(url, payment.body),
        pubkey
      )
      // the TollGate says it rotated the note; the mint has the last word
      if (payment.via === 'note') await wallet.refresh(payment.q)
      return session
    } catch (err) {
      if (!unsettled(err)) {
        if (payment.via !== 'key')
          await wallet.reclaim(payment.q).catch(() => undefined)
        throw err
      }
      if (attempt >= retry.attempts) throw err
      await new Promise(resolve => setTimeout(resolve, retry.delayMs))
    }
  }
}

export type Receipt = {session: Session; payment: Payment; steps: number}

/** Pays a TollGate for `steps` at a chosen offer, the way the mint's reach allows. */
export const payTollGate = async (
  wallet: Wallet,
  http: TollGateHttp,
  url: string,
  ad: Advertisement,
  choice: Choice,
  steps: number,
  retry?: Retry
): Promise<Receipt> => {
  const online = await wallet.reachable(choice.domain)
  const payment = await preparePayment(wallet, choice, steps, online)
  const session = await deliverPayment(
    wallet,
    http,
    url,
    ad.pubkey,
    payment,
    retry
  )
  return {session, payment, steps: stepsFor(choice.offer, payment.amountMsat)}
}
