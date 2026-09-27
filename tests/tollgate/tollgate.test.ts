// TollGate with LNURLcash: the draft TIP's wire format (events checked
// against nostr-tools), then Bearlett as the customer of a reference
// TollGate, both on an adversarial mock mint: by key, by note, offline with
// a whole note, and what an eavesdropper, a forger or a lost answer can do.
import {afterEach, describe, expect, it} from 'vitest'
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  verifyEvent
} from 'nostr-tools/pure'
import {schnorr} from '@noble/curves/secp256k1.js'
import {ProtocolError, TransportError} from '../../src/lnurl/errors.ts'
import type {Net} from '../../src/lnurl/net.ts'
import {fetchNet} from '../../src/platform/web.ts'
import {parseNoteLink} from '../../src/lnurl/links.ts'
import {fetchNoteInfo} from '../../src/lnurl/withdraw.ts'
import {bytesToHex, randomBytes} from '../../src/spec/bytes.ts'
import {encodeCp1, encodeCx1} from '../../src/spec/encoding.ts'
import {isValidEvent, signEvent} from '../../src/tollgate/nostr.ts'
import {
  choicesFor,
  deliverPayment,
  payTollGate,
  preparePayment,
  type Retry
} from '../../src/tollgate/customer.ts'
import {
  fetchTollGateHttp,
  keyPaymentBody,
  parseAdvertisement,
  parseKeyPayment,
  parsePaymentAnswer,
  priceMsat,
  TollGateNotice,
  tollGateUrl,
  type TollGateHttp
} from '../../src/tollgate/tollgate.ts'
import {
  hostOfMint,
  isBurn,
  losing,
  payInvoice,
  startMint,
  walletAt,
  type Mint
} from '../wallet/harness.ts'
import {startGate, type GateOptions} from './gate.ts'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

const fast: Retry = {attempts: 3, delayMs: 10}
const MINUTE = 60_000
const at = (seconds = 1_790_000_000) => seconds

// ---- the wire format ----

describe('events', () => {
  const tags = [
    ['metric', 'milliseconds'],
    ['step_size', '60000']
  ]

  it('signs events nostr-tools accepts, and accepts the ones it signs', () => {
    const ours = signEvent(randomBytes(32), {
      kind: 10021,
      created_at: at(),
      tags,
      content: ''
    })
    expect(getEventHash(ours)).toBe(ours.id)
    expect(verifyEvent({...ours})).toBe(true)
    const theirs = finalizeEvent(
      {kind: 10021, created_at: at(), tags, content: 'ä'},
      generateSecretKey()
    )
    expect(isValidEvent(theirs)).toBe(true)
  })

  it('rejects an event changed after signing, or not shaped like one', () => {
    const event = signEvent(randomBytes(32), {
      kind: 1022,
      created_at: at(),
      tags,
      content: ''
    })
    expect(isValidEvent(event)).toBe(true)
    expect(isValidEvent({...event, tags: [['allotment', '999999999']]})).toBe(
      false
    )
    expect(isValidEvent({...event, content: 'x'})).toBe(false)
    expect(
      isValidEvent({
        ...event,
        sig: event.sig.replace(/.$/, c => (c === '0' ? '1' : '0'))
      })
    ).toBe(false)
    expect(isValidEvent({...event, pubkey: event.pubkey.toUpperCase()})).toBe(
      false
    )
    expect(isValidEvent({...event, tags: [[1, 2]]})).toBe(false)
    expect(isValidEvent(null)).toBe(false)
    expect(isValidEvent('{"kind":1022}')).toBe(false)
  })
})

describe('advertisement', () => {
  const key = randomBytes(32)
  const cx1 = encodeCx1({
    p: schnorr.getPublicKey(randomBytes(32)),
    chainCode: randomBytes(32)
  })
  const advertise = (tags: string[][], kind = 10021) =>
    signEvent(key, {
      kind,
      created_at: at(),
      tags: [
        ['metric', 'milliseconds'],
        ['step_size', '60000'],
        ['tips', '1', '2'],
        ...tags
      ],
      content: ''
    })

  it('keeps the LNURLcash offers, in msat, with the branch published for each mint', () => {
    const ad = parseAdvertisement(
      advertise([
        ['price_per_step', 'cashu', '1', 'sat', 'https://cashu.example', '1'],
        [
          'price_per_step',
          'lnurlcash',
          '2',
          'sat',
          'https://mint.example/w',
          '3'
        ],
        [
          'price_per_step',
          'lnurlcash',
          '500',
          'msat',
          'lnurlw://127.0.0.1:3338/w?x=1',
          '0'
        ],
        ['lnurlcash_cpub', 'https://mint.example/w', `${cx1}:7`]
      ])
    )
    expect(ad.pubkey).toBe(bytesToHex(schnorr.getPublicKey(key)))
    expect(ad).toMatchObject({metric: 'milliseconds', stepSize: 60_000})
    expect(ad.offers).toHaveLength(2)
    expect(ad.offers[0]).toMatchObject({
      mint: 'https://mint.example/w',
      priceMsat: 2000,
      minSteps: 3
    })
    expect(ad.offers[0].cpub?.index).toBe(7)
    expect(encodeCx1(ad.offers[0].cpub!.branch)).toBe(cx1)
    expect(ad.offers[1]).toMatchObject({
      mint: 'http://127.0.0.1:3338/w',
      priceMsat: 500,
      minSteps: 0
    })
    expect(ad.offers[1].cpub).toBeUndefined()
  })

  it('skips offers nobody could pay safely or at all', () => {
    const ad = parseAdvertisement(
      advertise([
        ['price_per_step', 'lnurlcash', '0', 'sat', 'https://a.example/w', '1'],
        [
          'price_per_step',
          'lnurlcash',
          '1.5',
          'sat',
          'https://b.example/w',
          '1'
        ],
        ['price_per_step', 'lnurlcash', '1', 'eur', 'https://c.example/w', '1'],
        ['price_per_step', 'lnurlcash', '1', 'sat', 'http://d.example/w', '1'],
        ['price_per_step', 'lnurlcash', '1', 'sat', 'not a url', '1'],
        ['price_per_step', 'lnurlcash', '1', 'sat'],
        ['lnurlcash_cpub', 'https://e.example/w', 'cx1nonsense:1'],
        ['price_per_step', 'lnurlcash', '1', 'sat', 'https://e.example/w', '1']
      ])
    )
    expect(ad.offers).toEqual([
      {
        mint: 'https://e.example/w',
        priceMsat: 1000,
        minSteps: 1,
        cpub: undefined
      }
    ])
  })

  it('refuses anything but a signed kind-10021 with a metric and step size', () => {
    const good = advertise([])
    expect(() => parseAdvertisement({...good, content: 'changed'})).toThrow(
      ProtocolError
    )
    expect(() => parseAdvertisement(advertise([], 1022))).toThrow(ProtocolError)
    const noStep = signEvent(key, {
      kind: 10021,
      created_at: at(),
      tags: [['metric', 'milliseconds']],
      content: ''
    })
    expect(() => parseAdvertisement(noStep)).toThrow(ProtocolError)
    const oddMetric = signEvent(key, {
      kind: 10021,
      created_at: at(),
      tags: [
        ['metric', 'hours'],
        ['step_size', '1']
      ],
      content: ''
    })
    expect(() => parseAdvertisement(oddMetric)).toThrow(ProtocolError)
  })
})

describe('answers', () => {
  const key = randomBytes(32)
  const pubkey = bytesToHex(schnorr.getPublicKey(key))
  const answer = (kind: number, tags: string[][], content = '') =>
    signEvent(key, {kind, created_at: at(), tags, content})

  it('reads a session, and a notice as the error it is', () => {
    const session = parsePaymentAnswer(
      answer(1022, [
        ['device-identifier', 'mac', '00:1a:2b:3c:4d:5e'],
        ['allotment', '300000'],
        ['metric', 'milliseconds']
      ]),
      pubkey
    )
    expect(session).toMatchObject({allotment: 300_000, metric: 'milliseconds'})
    const notice = answer(
      21023,
      [
        ['level', 'error'],
        ['code', 'payment-error-token-spent']
      ],
      'Token has already been spent'
    )
    expect(() => parsePaymentAnswer(notice, pubkey)).toThrow(TollGateNotice)
    try {
      parsePaymentAnswer(notice, pubkey)
    } catch (err) {
      expect((err as TollGateNotice).code).toBe('payment-error-token-spent')
      expect((err as Error).message).toBe('Token has already been spent')
    }
  })

  it('trusts nothing the TollGate did not sign, nor a session without an allotment', () => {
    const forged = signEvent(randomBytes(32), {
      kind: 1022,
      created_at: at(),
      tags: [['allotment', '1']],
      content: ''
    })
    expect(() => parsePaymentAnswer(forged, pubkey)).toThrow(ProtocolError)
    expect(() => parsePaymentAnswer(answer(1, []), pubkey)).toThrow(
      ProtocolError
    )
    expect(() =>
      parsePaymentAnswer(answer(1022, [['allotment', '-5']]), pubkey)
    ).toThrow(ProtocolError)
    expect(() => parsePaymentAnswer({kind: 1022}, pubkey)).toThrow(
      ProtocolError
    )
  })
})

describe('addresses and bodies', () => {
  it('reads what a user types as HTTP-01 root, on networks a TollGate is found on', () => {
    expect(tollGateUrl('192.168.1.1')).toBe('http://192.168.1.1:2121/')
    expect(tollGateUrl('http://10.0.0.1:8080/portal?x=1')).toBe(
      'http://10.0.0.1:8080/'
    )
    expect(tollGateUrl('https://gate.example')).toBe('https://gate.example/')
    expect(tollGateUrl('npub1abc.fips')).toBe('http://npub1abc.fips:2121/')
    expect(tollGateUrl('localhost:2121')).toBe('http://localhost:2121/')
    expect(tollGateUrl('http://gate.example')).toBeNull()
    expect(tollGateUrl('8.8.8.8')).toBeNull()
    expect(tollGateUrl('')).toBeNull()
  })

  it('writes and reads a by-key body', () => {
    const q = schnorr.getPublicKey(randomBytes(32))
    const body = keyPaymentBody(encodeCp1(q), {
      mint: 'https://mint.example/w',
      priceMsat: 1000,
      minSteps: 0
    })
    expect(body).toMatch(/^cp1[0-9a-z]+@https:\/\/mint\.example\/w$/)
    const parsed = parseKeyPayment(body)!
    expect(bytesToHex(parsed.q)).toBe(bytesToHex(q))
    expect(parsed.endpoint).toBe('https://mint.example/w')
    expect(parseKeyPayment(`${encodeCp1(q)}@http://mint.example/w`)).toBeNull()
    expect(parseKeyPayment('cp1xyz@https://mint.example/w')).toBeNull()
    expect(parseKeyPayment('lnurlw://mint.example/w?k1=00')).toBeNull()
  })

  it('charges at least the minimum purchase', () => {
    const offer = {mint: 'https://mint.example/w', priceMsat: 1000, minSteps: 5}
    expect(priceMsat(offer, 1)).toBe(5000)
    expect(priceMsat(offer, 8)).toBe(8000)
    expect(priceMsat({...offer, minSteps: 0}, 0)).toBe(1000)
  })
})

// ---- Bearlett at a TollGate ----

const start = async (options = {}): Promise<Mint> => {
  const mint = await startMint({baseFeeMsat: 1000, ...options})
  closers.push(() => mint.close())
  return mint
}

const gateAt = async (
  mint: Mint,
  options: Partial<GateOptions> & {byKey?: boolean; minSteps?: number} = {}
) => {
  const {byKey, minSteps, ...rest} = options
  const gate = await startGate({
    mints: [{withdrawUrl: `${mint.url}/w`, priceMsat: 1000, minSteps, byKey}],
    ...rest
  })
  closers.push(() => gate.close())
  return gate
}

/** A mint, a TollGate taking its notes at 1 sat a minute, and a wallet with 49 sat there. */
const setup = async (options: Parameters<typeof gateAt>[1] = {}) => {
  const mint = await start()
  const gate = await gateAt(mint, options)
  const wallet = await walletAt(mint, 50_000)
  const ad = parseAdvertisement(await fetchTollGateHttp.get(gate.url))
  const [choice] = choicesFor(ad, wallet)
  return {mint, gate, wallet, ad, choice, domain: hostOfMint(mint)}
}

/** HTTP-01 from another device on the same network. */
const fromDevice = (device: string): TollGateHttp => ({
  get: url => fetchTollGateHttp.get(url),
  post: async (url, body) =>
    (
      await fetch(url, {
        method: 'POST',
        body,
        headers: {'x-test-device': device}
      })
    ).json()
})

describe('paying a TollGate', () => {
  it('pays by key where the TollGate publishes its branch: the exact price, nothing secret on the air', async () => {
    const {gate, wallet, ad, choice} = await setup({byKey: true})
    expect(choice.offer.cpub).toBeDefined()
    const receipt = await payTollGate(
      wallet,
      fetchTollGateHttp,
      gate.url,
      ad,
      choice,
      5,
      fast
    )
    expect(receipt.payment.via).toBe('key')
    expect(receipt.payment.body).toMatch(
      /^cp1[0-9a-z]+@http:\/\/127\.0\.0\.1:\d+\/w$/
    )
    expect(receipt.session.allotment).toBe(5 * MINUTE)
    expect(receipt.steps).toBe(5)
    // 49 sat less 5 for the TollGate and 1 for the split
    expect(wallet.balanceMsat()).toBe(43_000)
    expect(gate.held()).toEqual([
      expect.objectContaining({amountMsat: 5000, index: 0})
    ])
    // the key is the TollGate's own: it can spend what it was paid
    expect(await gate.sweep()).toBe(5000)
  })

  it('pays by a fresh bearer note of the exact price where it publishes no key', async () => {
    const {gate, wallet, ad, choice} = await setup()
    const receipt = await payTollGate(
      wallet,
      fetchTollGateHttp,
      gate.url,
      ad,
      choice,
      5,
      fast
    )
    expect(receipt.payment.via).toBe('note')
    expect(receipt.payment.body).toMatch(
      /^lnurlw:\/\/127\.0\.0\.1:\d+\/w\?k1=[0-9a-f]{64}&c=/
    )
    expect(receipt.session.allotment).toBe(5 * MINUTE)
    expect(wallet.balanceMsat()).toBe(43_000)
    // the TollGate rotated it, and the wallet has seen that at the mint
    expect(wallet.snapshot.notes[receipt.payment.q]).toMatchObject({
      role: 'outgoing',
      status: 'spent'
    })
    expect(await gate.sweep()).toBe(5000)
  })

  it('pays offline behind the portal with the smallest whole note, which buys all it is worth', async () => {
    const {mint, gate, wallet, ad, choice, domain} = await setup({byKey: true})
    const op = await wallet.requestMint(domain, 11_000)
    await payInvoice(mint, op.verify!)
    await wallet.settleMint(op)
    expect(wallet.balanceMsat()).toBe(59_000)
    await wallet.setOffline(true)
    const receipt = await payTollGate(
      wallet,
      fetchTollGateHttp,
      gate.url,
      ad,
      choice,
      5,
      fast
    )
    expect(receipt.payment.via).toBe('whole note')
    expect(receipt.payment.amountMsat).toBe(10_000)
    expect(receipt.payment.body).toMatch(/k1=ck1/)
    expect(receipt.steps).toBe(10)
    expect(receipt.session.allotment).toBe(10 * MINUTE)
    expect(wallet.balanceMsat()).toBe(49_000)
    // back online, the wallet learns the TollGate rotated it
    await wallet.setOffline(false)
    await wallet.settle()
    expect(wallet.snapshot.notes[receipt.payment.q]).toMatchObject({
      role: 'outgoing',
      status: 'spent'
    })
  })

  it('takes a refused note back at once', async () => {
    const {gate, wallet, ad, choice} = await setup({
      refuse: 'upstream-error-not-connected'
    })
    await expect(
      payTollGate(wallet, fetchTollGateHttp, gate.url, ad, choice, 5, fast)
    ).rejects.toMatchObject({
      name: 'TollGateNotice',
      code: 'upstream-error-not-connected'
    })
    // only the split fee is gone
    expect(wallet.balanceMsat()).toBe(48_000)
    expect(wallet.notes({role: 'outgoing', status: 'live'})).toEqual([])
  })

  it('takes the note back when the answer is not signed by the TollGate', async () => {
    const {gate, wallet, ad, choice} = await setup()
    const forging: TollGateHttp = {
      get: url => fetchTollGateHttp.get(url),
      post: async () =>
        signEvent(randomBytes(32), {
          kind: 1022,
          created_at: at(),
          tags: [['allotment', '999999999']],
          content: ''
        })
    }
    await expect(
      payTollGate(wallet, forging, gate.url, ad, choice, 5, fast)
    ).rejects.toThrow(ProtocolError)
    expect(wallet.balanceMsat()).toBe(48_000)
  })

  it('asks again after a lost answer and gets the same session, paid once', async () => {
    for (const byKey of [true, false]) {
      const {gate, wallet, ad, choice} = await setup({byKey})
      let lose = 1
      const lossy: TollGateHttp = {
        get: url => fetchTollGateHttp.get(url),
        post: async (url, body) => {
          const answer = await fetchTollGateHttp.post(url, body)
          if (lose-- > 0) throw new TransportError('The answer was lost.')
          return answer
        }
      }
      const receipt = await payTollGate(
        wallet,
        lossy,
        gate.url,
        ad,
        choice,
        5,
        fast
      )
      expect(receipt.session.allotment).toBe(5 * MINUTE)
      expect(gate.held()).toHaveLength(1)
    }
  })

  it('waits while the TollGate has no answer from the mint, and its replay lands once', async () => {
    for (const retriedMutation of ['replay', 'refuse'] as const) {
      const mint = await start({retriedMutation})
      const gate = await gateAt(mint, {net: losing(isBurn, 1)})
      const wallet = await walletAt(mint, 50_000)
      const ad = parseAdvertisement(await fetchTollGateHttp.get(gate.url))
      const [choice] = choicesFor(ad, wallet)
      const seen: number[] = []
      const watching: TollGateHttp = {
        get: url => fetchTollGateHttp.get(url),
        post: async (url, body) => {
          const answer = (await fetchTollGateHttp.post(url, body)) as {
            kind: number
          }
          seen.push(answer.kind)
          return answer
        }
      }
      const receipt = await payTollGate(
        wallet,
        watching,
        gate.url,
        ad,
        choice,
        5,
        fast
      )
      // first "payment-outcome-unknown", then the session
      expect(seen).toEqual([21023, 1022])
      expect(receipt.session.allotment).toBe(5 * MINUTE)
      expect(await gate.sweep()).toBe(5000)
    }
  })

  it('keeps a note whose fate is open handed out, and delivers the same payment later', async () => {
    const mint = await start()
    let down = false
    const upstream: Net = {
      async get(url, options) {
        if (down) throw new TransportError('The upstream is down.')
        const body = await fetchNet.get(url, options)
        if (isBurn(new URL(url))) {
          down = true
          throw new TransportError('The answer was lost.')
        }
        return body
      }
    }
    const gate = await gateAt(mint, {net: upstream})
    const wallet = await walletAt(mint, 50_000)
    const ad = parseAdvertisement(await fetchTollGateHttp.get(gate.url))
    const [choice] = choicesFor(ad, wallet)
    const payment = await preparePayment(wallet, choice, 5, true)
    await expect(
      deliverPayment(
        wallet,
        fetchTollGateHttp,
        gate.url,
        ad.pubkey,
        payment,
        fast
      )
    ).rejects.toMatchObject({code: 'payment-outcome-unknown'})
    // not taken back: the TollGate may still grant it
    expect(wallet.snapshot.notes[payment.q]).toMatchObject({
      role: 'outgoing',
      status: 'live'
    })
    down = false
    const session = await deliverPayment(
      wallet,
      fetchTollGateHttp,
      gate.url,
      ad.pubkey,
      payment,
      fast
    )
    expect(session.allotment).toBe(5 * MINUTE)
    expect(wallet.snapshot.notes[payment.q].status).toBe('spent')
  })

  it('charges the minimum purchase for fewer steps', async () => {
    const {gate, wallet, ad, choice} = await setup({byKey: true, minSteps: 10})
    const receipt = await payTollGate(
      wallet,
      fetchTollGateHttp,
      gate.url,
      ad,
      choice,
      1,
      fast
    )
    expect(receipt.payment.amountMsat).toBe(10_000)
    expect(receipt.session.allotment).toBe(10 * MINUTE)
  })

  it('finds no offer at a mint the wallet does not hold', async () => {
    const mint = await start()
    const other = await start()
    const gate = await gateAt(mint)
    const wallet = await walletAt(other, 50_000)
    const ad = parseAdvertisement(await fetchTollGateHttp.get(gate.url))
    expect(choicesFor(ad, wallet)).toEqual([])
  })
})

describe('what the air can do', () => {
  it('lets an eavesdropper race a note, and the customer lose it', async () => {
    const {mint, gate, wallet, ad, choice} = await setup()
    const thief = await walletAt(mint)
    const racing: TollGateHttp = {
      get: url => fetchTollGateHttp.get(url),
      post: async (url, body) => {
        await thief.receive(parseNoteLink(body)!)
        return fetchTollGateHttp.post(url, body)
      }
    }
    await expect(
      payTollGate(wallet, racing, gate.url, ad, choice, 5, fast)
    ).rejects.toMatchObject({code: 'payment-error-token-spent'})
    expect(thief.balanceMsat()).toBe(5000)
    expect(wallet.balanceMsat()).toBe(43_000)
    expect(wallet.notes({role: 'outgoing'})[0].status).toBe('spent')
  })

  it('lets an eavesdropper take a key payment’s session, never its sats', async () => {
    const {gate, wallet, ad, choice} = await setup({byKey: true})
    const racing: TollGateHttp = {
      get: url => fetchTollGateHttp.get(url),
      post: async (url, body) => {
        await fromDevice('thief').post(url, body)
        return fetchTollGateHttp.post(url, body)
      }
    }
    await expect(
      payTollGate(wallet, racing, gate.url, ad, choice, 5, fast)
    ).rejects.toMatchObject({code: 'payment-error-token-spent'})
    expect(gate.allotment('thief')).toBe(5 * MINUTE)
    expect(await gate.sweep()).toBe(5000)
  })
})

describe('the reference TollGate', () => {
  it('refuses notes from mints it does not accept, and keys not its own', async () => {
    const mint = await start()
    const other = await start()
    const gate = await gateAt(mint, {byKey: true})
    const stranger = await walletAt(other, 20_000)
    const note = await stranger.send(hostOfMint(other), 5000)
    const answer = await fetchTollGateHttp.post(
      gate.url,
      stranger.noteLink(note.q)
    )
    expect(() => parsePaymentAnswer(answer, gate.pubkey)).toThrow(
      /does not accept/
    )
    const key = encodeCp1(schnorr.getPublicKey(randomBytes(32)))
    const byKey = await fetchTollGateHttp.post(gate.url, `${key}@${mint.url}/w`)
    expect(() => parsePaymentAnswer(byKey, gate.pubkey)).toThrow(
      /not one of this TollGate/
    )
  })

  it('refuses a note below the minimum before spending it', async () => {
    const mint = await start()
    const gate = await gateAt(mint, {minSteps: 10})
    const wallet = await walletAt(mint, 50_000)
    const note = await wallet.send(hostOfMint(mint), 5000)
    const link = wallet.noteLink(note.q)
    const answer = await fetchTollGateHttp.post(gate.url, link)
    expect(() => parsePaymentAnswer(answer, gate.pubkey)).toThrow(
      TollGateNotice
    )
    const info = await fetchNoteInfo(
      (await import('../../src/platform/web.ts')).fetchNet,
      parseNoteLink(link)!.endpoint,
      {k1: parseNoteLink(link)!.k1}
    )
    expect(info.amountMsat).toBe(5000)
  })

  it('takes a note inside a kind-21000 payment event as well', async () => {
    const mint = await start()
    const gate = await gateAt(mint)
    const wallet = await walletAt(mint, 50_000)
    const note = await wallet.send(hostOfMint(mint), 3000)
    const event = finalizeEvent(
      {
        kind: 21000,
        created_at: at(),
        tags: [['payment', wallet.noteLink(note.q)]],
        content: ''
      },
      generateSecretKey()
    )
    const answer = await fetchTollGateHttp.post(gate.url, JSON.stringify(event))
    expect(parsePaymentAnswer(answer, gate.pubkey).allotment).toBe(3 * MINUTE)
  })
})
