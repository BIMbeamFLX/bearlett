// The wallet's flows end to end against an adversarial mock mint over real
// HTTP: minting, handing out and receiving, paying, lost answers and
// crashes, trust, recovery and timelocks.
import {afterEach, describe, expect, it} from 'vitest'
import {bech32} from '@scure/base'
import {hexToBytes} from '../../src/spec/bytes.ts'
import {fetchNet} from '../../src/platform/web.ts'
import {
  ProtocolError,
  ServiceError,
  TransportError
} from '../../src/lnurl/errors.ts'
import {parseNoteLink} from '../../src/lnurl/links.ts'
import {fetchNoteInfo} from '../../src/lnurl/withdraw.ts'
import {notePubkey, PURPOSE} from '../../src/spec/derivation.ts'
import {decodeCp1, encodeCp1} from '../../src/spec/encoding.ts'
import {memoryStore, type Store} from '../../src/wallet/store.ts'
import {newMnemonic} from '../../src/wallet/vault.ts'
import {
  MintKeyChangedError,
  UnknownMintError,
  Wallet
} from '../../src/wallet/wallet.ts'
import {
  hanging,
  hostOfMint,
  isBurn,
  isCallback,
  losing,
  payInvoice,
  payUrl,
  rewriting,
  startMint,
  walletAt,
  type Mint
} from './harness.ts'

const mints: Mint[] = []
const start = async (options = {}) => {
  const mint = await startMint(options)
  mints.push(mint)
  return mint
}
afterEach(async () => {
  while (mints.length) await mints.pop()!.close()
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A BOLT-11 invoice for 10 sat with the fields a wallet reads: a payment
 * hash, a timestamp and an expiry. Its signature is zeros: the mint that
 * pays checks it, and the test mint pays anything.
 */
const bolt11 = (terms: {
  hash: string
  timestamp: number
  expiry?: number
  expiryWords?: number[]
}) => {
  const number = (value: number, length: number) =>
    Array.from(
      {length},
      (_, i) => Math.floor(value / 32 ** (length - 1 - i)) % 32
    )
  const field = (type: number, data: number[]) => [
    type,
    Math.floor(data.length / 32),
    data.length % 32,
    ...data
  ]
  const words = [
    ...number(terms.timestamp, 7),
    ...field(1, bech32.toWords(hexToBytes(terms.hash))),
    ...field(6, terms.expiryWords ?? number(terms.expiry ?? 3600, 6)),
    ...new Array(104).fill(0)
  ]
  return bech32.encode('lnbc100n', words, false)
}

describe('minting', () => {
  it('credits a fresh key of its own once the invoice is paid, less the fee', async () => {
    const mint = await start({baseFeeMsat: 1000})
    const wallet = await walletAt(mint)
    const host = hostOfMint(mint)
    const op = await wallet.requestMint(host, 100_000)
    expect(await wallet.settleMint(op)).toBe(false)
    await payInvoice(mint, op.verify!)
    expect(await wallet.settleMint(op)).toBe(true)
    expect(wallet.balanceMsat()).toBe(99_000)
    const [note] = wallet.notes({role: 'own', status: 'live'})
    expect(note.spend).toEqual({kind: 'key', key: {purpose: 0, index: 0}})
    expect(note.c).toBeDefined()
    expect(wallet.snapshot.mints[host].mintPubkey).toMatch(
      /^0[23][0-9a-f]{64}$/
    )
  })

  it('records a mint once, however many callers settle it at the same time', async () => {
    const mint = await start()
    const wallet = await walletAt(mint)
    const op = await wallet.requestMint(hostOfMint(mint), 20_000)
    await payInvoice(mint, op.verify!)
    // the Receive screen polls while settle() runs on its timer
    await Promise.all([wallet.settleMint(op), wallet.settleMint(op)])
    await wallet.settleMint(op)
    const minted = wallet.snapshot.activity.filter(a => a.kind === 'mint')
    expect(minted).toHaveLength(1)
    expect(wallet.balanceMsat()).toBe(20_000)
  })

  it('keeps an unpaid invoice underway until it is forgotten', async () => {
    const mint = await start()
    const wallet = await walletAt(mint)
    const op = await wallet.requestMint(hostOfMint(mint), 5_000)
    await wallet.settle()
    expect(wallet.snapshot.operations[op.id]).toBeDefined()
    await wallet.dropMint(op)
    expect(wallet.snapshot.operations[op.id]).toBeUndefined()
  })
})

describe('handing out and receiving', () => {
  it('hands out a bearer link that another wallet receives and rotates', async () => {
    const mint = await start({baseFeeMsat: 1000})
    const alice = await walletAt(mint, 100_000)
    const bob = await walletAt(mint)
    const sent = await alice.send(hostOfMint(mint), 30_000, 'for bob')
    expect(alice.balanceMsat()).toBe(99_000 - 30_000 - 1000)
    const link = parseNoteLink(alice.noteLink(sent.q))!
    // the link is a bearer note: its k1 is the 64-hex preimage
    expect(link.k1).toMatch(/^[0-9a-f]{64}$/)
    await bob.receive(link)
    expect(bob.balanceMsat()).toBe(30_000)
    expect(bob.notes({role: 'incoming', status: 'live'})).toHaveLength(0)
    await alice.checkOutgoing()
    expect(alice.snapshot.notes[sent.q].status).toBe('spent')
    await expect(bob.receive(link)).rejects.toThrow(/already spent/)
  })

  it('refuses a note from an unknown mint until the holder trusts it', async () => {
    const mint = await start()
    const alice = await walletAt(mint, 10_000)
    const carol = await Wallet.create(
      {net: fetchNet, store: memoryStore()},
      newMnemonic(),
      ''
    )
    const link = parseNoteLink(
      alice.noteLink((await alice.send(hostOfMint(mint), 10_000)).q)
    )!
    await expect(carol.receive(link)).rejects.toBeInstanceOf(UnknownMintError)
    await carol.trustMintOf(link.endpoint)
    await carol.receive(link)
    expect(carol.balanceMsat()).toBe(10_000)
  })

  it('takes back a note nobody rotated', async () => {
    const mint = await start()
    const alice = await walletAt(mint, 10_000)
    const sent = await alice.send(hostOfMint(mint), 4_000)
    expect(alice.balanceMsat()).toBe(6_000)
    await alice.reclaim(sent.q)
    expect(alice.balanceMsat()).toBe(10_000)
  })

  it('keeps a note received offline and rotates it once the mint answers', async () => {
    const mint = await start()
    const alice = await walletAt(mint, 10_000)
    let online = false
    const flaky = {
      async get(
        url: string,
        options?: {signal?: AbortSignal; secret?: boolean}
      ) {
        if (!online && new URL(url).searchParams.has('k1'))
          throw new TransportError('No answer.')
        return fetchNet.get(url, options)
      }
    }
    const bob = await walletAt(mint, 1_000, {net: flaky})
    const link = parseNoteLink(
      alice.noteLink((await alice.send(hostOfMint(mint), 10_000)).q)
    )!
    const kept = await bob.receive(link)
    // offline: its amount comes from the certificate, under the pinned key
    expect(kept.role).toBe('incoming')
    expect(kept.amountMsat).toBe(10_000)
    online = true
    await bob.settle()
    expect(bob.balanceMsat()).toBe(11_000)
  })
})

describe('paying', () => {
  it('splits off the exact amount and melts it', async () => {
    const mint = await start({baseFeeMsat: 1000})
    const wallet = await walletAt(mint, 50_000)
    const melt = await wallet.pay(
      hostOfMint(mint),
      'lnbc100n1' + 'q'.repeat(52)
    )
    expect(melt.state).toBe('in-flight')
    await sleep(60)
    await wallet.settle()
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(0)
    expect(wallet.balanceMsat()).toBe(49_000 - 10_000 - 1000)
    // asked once more after it settled: nothing is recorded twice
    await wallet.settleMelt(melt)
    const paid = wallet.snapshot.activity.filter(a => a.kind === 'pay')
    expect(paid).toHaveLength(1)
  })

  it('leaves a payment being written down to the pay() that sends it', async () => {
    const mint = await start()
    const inner = memoryStore()
    let slow = false
    // every write takes a while, as a round trip to the Hangar's storage does
    const store: Store = {
      get: key => inner.get(key),
      remove: key => inner.remove(key),
      async set(key, value) {
        if (slow) await sleep(300)
        await inner.set(key, value)
      }
    }
    const wallet = await walletAt(mint, 30_000, {store})
    slow = true
    const paying = wallet.pay(hostOfMint(mint), 'lnbc300n1' + 'q'.repeat(52))
    await sleep(120)
    // the melt is in the journal, not yet on disk: settle() must leave it be
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(1)
    await wallet.settle()
    const melt = await paying
    expect(melt.state).toBe('in-flight')
    slow = false
    await sleep(60)
    await wallet.settle()
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(0)
    expect(wallet.balanceMsat()).toBe(0)
    expect(wallet.snapshot.activity[0].text).toBe('Paid an invoice')
  })

  it('pays an invoice once when asked twice at once', async () => {
    const mint = await start({meltNeverSettles: true})
    const wallet = await walletAt(mint, 50_000)
    const invoice = 'lnbc100n1' + 'q'.repeat(52)
    const [first, second] = await Promise.allSettled([
      wallet.pay(hostOfMint(mint), invoice),
      wallet.pay(hostOfMint(mint), invoice)
    ])
    expect(first.status).toBe('fulfilled')
    expect(second.status === 'rejected' && String(second.reason)).toMatch(
      /being paid already/
    )
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(1)
  })

  it('remembers a paid invoice by its payment hash until it can no longer be paid', async () => {
    const mint = await start({baseFeeMsat: 1000})
    let now = Date.now()
    const wallet = await walletAt(mint, 50_000, {now: () => now})
    const hash = 'ab'.repeat(32)
    const twoMonths = 60 * 24 * 3600
    const invoice = bolt11({
      hash,
      timestamp: Math.floor(now / 1000),
      expiry: twoMonths
    })
    await wallet.pay(hostOfMint(mint), invoice)
    await sleep(60)
    await wallet.settle()
    // kept by its hash, not its text
    expect(Object.keys(wallet.snapshot.paid)).toEqual([hash])
    // another invoice for the same payment is the same payment
    const again = bolt11({
      hash,
      timestamp: Math.floor(now / 1000) + 1,
      expiry: twoMonths
    })
    await expect(wallet.pay(hostOfMint(mint), again)).rejects.toThrow(
      /paid already/
    )
    // 31 days on it can still be paid, so it is still refused
    now += 31 * 24 * 3600 * 1000
    await expect(wallet.pay(hostOfMint(mint), invoice)).rejects.toThrow(
      /paid already/
    )
    // once it can no longer be paid, it is forgotten
    now += 31 * 24 * 3600 * 1000
    expect(wallet.invoiceStatus(invoice)).toBeNull()
  })

  it('keeps a paid invoice for good when its expiry is too long to read', async () => {
    const mint = await start({baseFeeMsat: 1000})
    const wallet = await walletAt(mint, 50_000)
    const hash = 'cd'.repeat(32)
    const invoice = bolt11({
      hash,
      timestamp: Math.floor(Date.now() / 1000),
      expiryWords: new Array(11).fill(31)
    })
    await wallet.pay(hostOfMint(mint), invoice)
    await sleep(60)
    await wallet.settle()
    expect(wallet.snapshot.paid[hash]).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('does not pay an invoice again once it is paid', async () => {
    const mint = await start({baseFeeMsat: 1000})
    const wallet = await walletAt(mint, 50_000)
    const invoice = 'lnbc100n1' + 'q'.repeat(52)
    expect(wallet.invoiceStatus(invoice)).toBeNull()
    await wallet.pay(hostOfMint(mint), invoice)
    expect(wallet.invoiceStatus(invoice)).toBe('paying')
    await sleep(60)
    await wallet.settle()
    expect(wallet.invoiceStatus(invoice)).toBe('paid')
    const before = wallet.balanceMsat()
    // however it is written
    await expect(
      wallet.pay(hostOfMint(mint), `lightning:${invoice.toUpperCase()}`)
    ).rejects.toThrow(/paid already/)
    expect(wallet.balanceMsat()).toBe(before)
  })

  it('does not pay an invoice again while it is being paid', async () => {
    const mint = await start({meltNeverSettles: true})
    const wallet = await walletAt(mint, 30_000)
    const invoice = 'lnbc100n1' + 'q'.repeat(52)
    await wallet.pay(hostOfMint(mint), invoice)
    const before = wallet.balanceMsat()
    await expect(wallet.pay(hostOfMint(mint), invoice)).rejects.toThrow(
      /being paid already/
    )
    // nothing split off for it
    expect(wallet.balanceMsat()).toBe(before)
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(1)
  })

  it('restores the note when the payment fails', async () => {
    const mint = await start({meltAlwaysFails: true})
    const wallet = await walletAt(mint, 20_000)
    await wallet.pay(hostOfMint(mint), 'lnbc200n1' + 'q'.repeat(52))
    await sleep(60)
    await wallet.settle()
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(0)
    expect(wallet.balanceMsat()).toBe(20_000)
  })

  it('keeps a payment that never settles underway, its note pending', async () => {
    const mint = await start({meltNeverSettles: true})
    const wallet = await walletAt(mint, 20_000)
    const melt = await wallet.pay(
      hostOfMint(mint),
      'lnbc200n1' + 'q'.repeat(52)
    )
    await wallet.settle()
    expect(wallet.snapshot.operations[melt.id]).toBeDefined()
    expect(wallet.snapshot.notes[melt.input].status).toBe('pending')
  })

  it('sends to a note key someone gave as a cp1', async () => {
    const mint = await start()
    const alice = await walletAt(mint, 20_000)
    const bob = await walletAt(mint)
    const cp1 = encodeCp1(
      decodeCp1(
        (bob as any).keys.cp1(hostOfMint(mint), {purpose: 0, index: 5})
      )!
    )
    await alice.sendToKey(hostOfMint(mint), 7_000, decodeCp1(cp1)!)
    expect(alice.balanceMsat()).toBe(13_000)
    // whoever holds the key finds it by scanning
    expect(await bob.recover(hostOfMint(mint))).toBe(1)
    expect(bob.balanceMsat()).toBe(7_000)
  })

  it('pays an address at the same mint by internal transfer, skipping a taken index', async () => {
    const mint = await start({registeredAddress: true})
    const alice = await walletAt(mint, 30_000)
    const pay = await alice.payRequest(payUrl(mint))
    expect(pay.cpub).toBeDefined()
    expect(alice.transferMint(pay)).toBe(hostOfMint(mint))
    // someone got to the hinted index first
    const taken = notePubkey(
      pay.cpub!.branch,
      PURPOSE.lightningAddress,
      pay.cpub!.index
    )
    await fetch(`${mint.url}/_test/credit?p=${encodeCp1(taken)}&amount=1000`)
    await alice.transfer(pay, 8_000)
    expect(alice.balanceMsat()).toBe(22_000)
    const next = notePubkey(
      pay.cpub!.branch,
      PURPOSE.lightningAddress,
      pay.cpub!.index + 1
    )
    const credited = await fetchNoteInfo(fetchNet, `${mint.url}/w`, {
      p: encodeCp1(next)
    })
    expect(credited.amountMsat).toBe(8_000)
  })
})

describe('the address scan and the mint’s index hint', () => {
  /**
   * A wallet whose Lightning Address is the mock mint's own name, the mint
   * hinting `hint` as the next index it hands out (its text/cpub), and a
   * way to pay the address at any index.
   */
  const addressed = async (hint: number, words = newMnemonic()) => {
    const mint = await start()
    const domain = hostOfMint(mint)
    const box: {wallet?: Wallet} = {}
    const net: Net = {
      async get(url, options) {
        const body = await fetchNet.get(url, options)
        if (!box.wallet || !url.endsWith('/.well-known/lnurlp/mint'))
          return body
        const metadata = JSON.parse(body.metadata as string)
        const cx1 = (box.wallet as any).keys.cx1(domain)
        metadata.push(['text/cpub', `${cx1}:${hint}`])
        return {...body, metadata: JSON.stringify(metadata)}
      }
    }
    const wallet = await walletAt(mint, 0, {net, words})
    box.wallet = wallet
    ;(wallet as any).state.addresses[domain] = {
      username: 'mint',
      mint: domain,
      since: 0
    }
    const pay = async (index: number) => {
      const cp1 = (wallet as any).keys.cp1(domain, {
        purpose: PURPOSE.lightningAddress,
        index
      })
      await fetch(`${mint.url}/_test/credit?p=${cp1}&amount=1000`)
    }
    return {mint, domain, wallet, pay}
  }

  it('finds a note below the hint, which moves on when an invoice is handed out', async () => {
    const words = newMnemonic()
    // one payment, at index 0; the mint handed out indexes 1 and 2 unpaid
    const {mint, domain, wallet, pay} = await addressed(3, words)
    await pay(0)
    expect(await wallet.checkAddress(domain)).toBe(1)
    expect(wallet.balanceMsat()).toBe(1000)
    // and the words alone find it, the hint never asked
    const restored = await walletAt(mint, 0, {words})
    expect(await restored.recover(domain)).toBe(1)
  })

  it('finds a note that settled below where the last look ended', async () => {
    const {domain, wallet, pay} = await addressed(3)
    await pay(0)
    await pay(2)
    expect(await wallet.checkAddress(domain)).toBe(2)
    // index 1 settles late, below the counter the last look left
    await pay(1)
    expect(await wallet.checkAddress(domain)).toBe(1)
    expect(wallet.balanceMsat()).toBe(3000)
  })
})

describe('lost answers and crashes', () => {
  it('settles a burn whose answer was lost after it landed', async () => {
    const mint = await start()
    const wallet = await walletAt(mint, 10_000, {net: losing(isBurn)})
    await expect(wallet.send(hostOfMint(mint), 3_000)).rejects.toBeInstanceOf(
      TransportError
    )
    const [op] = Object.values(wallet.snapshot.operations)
    expect(op.kind === 'burn' && op.state).toBe('unknown')
    await wallet.settle()
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(0)
    expect(wallet.balanceMsat()).toBe(7_000)
    expect(wallet.notes({role: 'outgoing', status: 'live'})).toHaveLength(1)
  })

  it('settles it once when the timer and "Check now" ask together', async () => {
    const mint = await start()
    const wallet = await walletAt(mint, 10_000, {net: losing(isBurn)})
    await expect(wallet.send(hostOfMint(mint), 3_000)).rejects.toBeInstanceOf(
      TransportError
    )
    const first = wallet.settle()
    // the second call joins the run under way
    expect(wallet.settle()).toBe(first)
    await first
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(0)
    expect(wallet.balanceMsat()).toBe(7_000)
    expect(wallet.notes({role: 'outgoing', status: 'live'})).toHaveLength(1)
    // and a later call is a run of its own
    expect(wallet.settle()).not.toBe(first)
  })

  it('gives up on an answer that never comes, and settles the rest', async () => {
    const mint = await start()
    let stall = false
    let stalled = 0
    const net: Net = {
      async get(url, options) {
        // one lookup that never answers, as a hung connection
        if (stall && new URL(url).searchParams.has('p') && stalled++ === 0)
          return new Promise(() => {})
        return fetchNet.get(url, options)
      }
    }
    const wallet = await walletAt(mint, 0, {net, timeoutMs: 300})
    const op = await wallet.requestMint(hostOfMint(mint), 5_000)
    await payInvoice(mint, op.verify!)
    stall = true
    const started = Date.now()
    await wallet.settle()
    expect(Date.now() - started).toBeLessThan(5_000)
    // the stuck entry is still open, and the next settle() is not held by it
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(1)
    await wallet.settle()
    expect(wallet.balanceMsat()).toBe(5_000)
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(0)
  })

  it('settles it at a mint that drops the answer and refuses replays', async () => {
    const mint = await start({
      dropAfterMutation: true,
      retriedMutation: 'refuse'
    })
    const wallet = await walletAt(mint, 10_000)
    await expect(wallet.send(hostOfMint(mint), 3_000)).rejects.toThrow()
    await wallet.settle()
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(0)
    expect(wallet.balanceMsat()).toBe(7_000)
  })

  it('settles a burn the mint answered without confirming', async () => {
    const mint = await start({unconfirmedMutation: true})
    const wallet = await walletAt(mint, 10_000)
    await expect(wallet.send(hostOfMint(mint), 2_500)).rejects.toThrow(
      /did not confirm/
    )
    await wallet.settle()
    expect(wallet.balanceMsat()).toBe(7_500)
  })

  it('resolves a burn left behind by a crash after it was sent', async () => {
    const mint = await start()
    const store = memoryStore()
    const words = newMnemonic()
    const crashing = await walletAt(mint, 10_000, {
      net: hanging(isBurn),
      store,
      words
    })
    void crashing.send(hostOfMint(mint), 4_000)
    await sleep(300)
    // the app restarts from what it stored: the burn is still "prepared"
    const reopened = await Wallet.unlock({net: fetchNet, store}, '')
    const [op] = Object.values(reopened.snapshot.operations)
    expect(op.kind === 'burn' && op.state).toBe('prepared')
    await reopened.settle()
    expect(Object.keys(reopened.snapshot.operations)).toHaveLength(0)
    expect(reopened.balanceMsat()).toBe(6_000)
  })

  it('marks a received note spent when its sender spent it first, and says so', async () => {
    const mint = await start()
    const alice = await walletAt(mint, 10_000)
    const sent = await alice.send(hostOfMint(mint), 10_000)
    const link = parseNoteLink(alice.noteLink(sent.q))!
    let online = false
    const offline = await walletAt(mint, 0, {
      net: {
        async get(url, options) {
          if (!online && new URL(url).searchParams.has('k1'))
            throw new TransportError('No answer.')
          return fetchNet.get(url, options)
        }
      }
    })
    await offline.receive(link)
    // the sender takes it back before the holder is online again
    await alice.reclaim(sent.q)
    online = true
    await offline.settle()
    const [note] = offline.notes({role: 'incoming'})
    expect(note.status).toBe('spent')
    expect(offline.balanceMsat()).toBe(0)
    expect(offline.snapshot.activity[0].text).toMatch(/spent by someone else/)
  })
})

describe('trust', () => {
  it('refuses a mint that echoes another note', async () => {
    const mint = await start({echoWrongK1: true})
    const alice = await walletAt(mint, 5_000)
    const bob = await walletAt(mint)
    const link = parseNoteLink(
      alice.noteLink((await alice.send(hostOfMint(mint), 5_000)).q)
    )!
    await expect(bob.receive(link)).rejects.toBeInstanceOf(ProtocolError)
    // and it is not quietly kept as if the mint were offline
    expect(bob.notes({role: 'incoming'})).toHaveLength(0)
  })

  it('refuses a mint whose key changed since it was pinned', async () => {
    const mint = await start()
    let swap = false
    const net = rewriting((_, body) =>
      swap && typeof body.mintPubkey === 'string'
        ? {
            ...body,
            // a valid key, just not the one pinned: the generator point
            mintPubkey:
              '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
          }
        : body
    )
    const wallet = await walletAt(mint, 5_000, {net})
    const alice = await walletAt(mint, 5_000)
    const link = parseNoteLink(
      alice.noteLink((await alice.send(hostOfMint(mint), 5_000)).q)
    )!
    swap = true
    await expect(wallet.receive(link)).rejects.toBeInstanceOf(
      MintKeyChangedError
    )
  })

  it('refuses a lookup that is not a withdrawRequest', async () => {
    const mint = await start({malformedJson: true})
    await expect(
      fetchNoteInfo(fetchNet, `${mint.url}/w`, {p: 'cp1' + 'q'.repeat(58)})
    ).rejects.toThrow()
  })
})

describe('recovery from the words alone', () => {
  it('finds every purpose and advances each counter past what it found', async () => {
    const mint = await start({baseFeeMsat: 1000, registeredAddress: true})
    const words = newMnemonic()
    const alice = await walletAt(mint, 60_000, {words})
    await alice.send(hostOfMint(mint), 10_000)
    await alice.pay(hostOfMint(mint), 'lnbc50n1' + 'q'.repeat(52))
    await sleep(60)
    await alice.settle()
    const restored = await walletAt(mint, 0, {words})
    await restored.recover(hostOfMint(mint))
    expect(restored.balanceMsat()).toBe(alice.balanceMsat())
    const [w0, w1] = alice.snapshot.counters[hostOfMint(mint)]
    const [r0, r1] = restored.snapshot.counters[hostOfMint(mint)]
    expect([r0, r1]).toEqual([w0, w1])
  })

  it('waits out a rate limit without counting it toward the gap', async () => {
    const mint = await start()
    const words = newMnemonic()
    const alice = await walletAt(mint, 5_000, {words})
    let limited = 1
    const net = {
      async get(
        url: string,
        options?: {signal?: AbortSignal; secret?: boolean}
      ) {
        if (limited > 0 && new URL(url).searchParams.has('p')) {
          limited--
          throw new ServiceError('rate limited')
        }
        return fetchNet.get(url, options)
      }
    }
    const restored = await walletAt(mint, 0, {words, net})
    await restored.recover(hostOfMint(mint))
    expect(restored.balanceMsat()).toBe(alice.balanceMsat())
  })
})

describe('offline mode', () => {
  it('sends nothing to any mint', async () => {
    const mint = await start()
    const wallet = await walletAt(mint, 5_000)
    await wallet.setOffline(true)
    await expect(wallet.send(hostOfMint(mint), 1_000)).rejects.toThrow(
      /Offline mode/
    )
    expect(wallet.balanceMsat()).toBe(5_000)
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(0)
  })
})

describe('timelocks', () => {
  it('locks sats until a time; neither the wallet nor the mint lets them out early', async () => {
    const mint = await start()
    const wallet = await walletAt(mint, 20_000)
    const until = Math.floor(Date.now() / 1000) + 3600
    const locked = await wallet.lock(hostOfMint(mint), 8_000, until)
    expect(locked.role).toBe('locked')
    expect(wallet.balanceMsat()).toBe(12_000)
    await expect(wallet.unlock(locked.q)).rejects.toThrow(/still locked/)
    const cw1 = (wallet as any).spendOf(locked)
    await expect(
      fetchNoteInfo(fetchNet, `${mint.url}/w`, {k1: cw1})
    ).rejects.toThrow(/future/)
  })
})
